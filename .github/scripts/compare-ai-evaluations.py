"""Compare verified compact AI archives on identical opponents and paired scenarios.

This checks archived data and its game-file digest. Raw artifact/receipt verification
must precede archival. A promising result is one evaluation gate, not a release.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import random
import re


COMPARABLE = ('baselineCommit', 'baselineProfile', 'candidateProfile', 'engineSourceSha256',
              'runnerSourceSha256', 'bunVersion', 'lockfileSha256', 'resourceLoaderSha256',
              'countries', 'maxTicks', 'sampleTicks', 'credits', 'unitCount', 'iniSha256',
              'customIniSha256', 'engineDifficulty', 'pairedSpawnSwap', 'pairedPlayerOrderSwap')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def normalized_map(name):
    return re.sub(r'\.(map|mpr)$', '', name)


def identity(game):
    return (game['candidateCountry'], game['baselineCountry'], normalized_map(game['map']), game['seed'], game['swapped'])


def counts(games):
    result = Counter(g['result'] for g in games)
    total = len(games)
    require(total > 0, 'Empty evaluation group')
    wins, losses, draws = (result[r] for r in ('candidate-win', 'baseline-win', 'draw'))
    return dict(wins=wins, losses=losses, draws=draws, games=total, winRate=wins / total,
                decisiveWinRate=wins / (wins + losses) if wins + losses else None)


def load_archives(paths, plan):
    config, candidate, games, sources, resources = None, None, {}, [], {}
    for path in paths:
        archive = json.loads(path.read_text())
        cfg, invariants = archive['config'], archive['invariants']
        require(re.fullmatch(r'[a-f0-9]{40}', cfg['candidateCommit']) is not None, 'Candidate must be frozen')
        require(invariants.get('receiptsVerified') is True and invariants.get('errors') == 0 and
                invariants.get('missing') == 0 and invariants.get('mixedVersions') is False,
                'Archive lacks valid receipt/integrity evidence')
        require(cfg['countries'] == plan['countries'], 'Country schedule differs from plan')
        require(all(cfg.get(k) == v for k, v in plan['settings'].items()), 'Game settings differ from plan')
        require(any(cfg['baselineCommit'] == b['commit'] and cfg['baselineProfile'] == b['profile']
                    for b in plan['baselines']), 'Unregistered opponent or profile')
        current = {key: cfg[key] for key in COMPARABLE}
        if config is not None:
            require(config == current and candidate == cfg['candidateCommit'], 'Mixed archive versions or settings')
        config, candidate = current, cfg['candidateCommit']
        name = archive['gamesFile']
        require(Path(name).name == name and name not in ('.', '..'), 'Game file must be adjacent to archive')
        raw = (path.parent / name).read_bytes()
        require(hashlib.sha256(raw).hexdigest() == archive['archivedFilesSha256'].get(name), 'Game file hash mismatch')
        shard = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
        scenarios = {(normalized_map(m), seed) for m, seed in archive['scenarios']}
        require(len(scenarios) == 3, 'Each archive must contain three scenarios')
        manifest_scenarios = set()
        for receipt in archive['manifestReceipts']:
            values = receipt['config']['scenarios']
            require(len(values) == 1, 'Each manifest must identify one map/seed')
            value = values[0]
            resource_key = (normalized_map(value['map']), value['seed'])
            require(resource_key in scenarios and resource_key not in manifest_scenarios, 'Manifest scenario mismatch')
            proof = {key: value[key] for key in ('mapSha256', 'terrainSha256', 'terrainFile')}
            require(all(re.fullmatch(r'[a-f0-9]{64}', proof[key]) is not None for key in ('mapSha256', 'terrainSha256')),
                    'Missing map or terrain digest')
            resources[resource_key] = proof
            manifest_scenarios.add(resource_key)
        require(manifest_scenarios == scenarios, 'Incomplete map/terrain receipts')
        countries = cfg['countries']
        expected = {(a, b, m, s, swap) for a in countries for b in countries if a != b
                    for m, s in scenarios for swap in (False, True)}
        seen = set()
        for game in shard:
            require(type(game['swapped']) is bool and type(game['seed']) is int, 'Invalid swap or seed')
            require(type(game.get('errorCount')) is int and game['errorCount'] == 0, 'Runtime errors or missing error telemetry')
            require(game['result'] in ('candidate-win', 'baseline-win', 'draw'), 'Invalid result')
            require(type(game['ticks']) is int and 0 < game['ticks'] <= cfg['maxTicks'], 'Invalid game duration')
            require((game['result'] == 'draw' and game['reason'] == 'tick-limit' and game['ticks'] == cfg['maxTicks']) or
                    (game['result'] != 'draw' and game['reason'] == 'engine-victory-conditions'), 'Invalid outcome reason')
            key = identity(game)
            require(key in expected and key not in seen and key not in games, 'Unexpected or duplicate game')
            seen.add(key)
            games[key] = game
        require(seen == expected, 'Missing games or spawn swaps')
        actual = counts(shard)
        require(all(actual[k] == archive['totals'][k] for k in ('wins', 'losses', 'draws', 'games')) and
                math.isclose(actual['winRate'], archive['totals']['winRate'], abs_tol=1e-12), 'Archive totals disagree with games')
        sources.append(dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(), runId=archive['runId']))
    require(config is not None, 'No archives supplied')
    return dict(config=config, candidate=candidate, games=games, sources=sources, scenarioResources=resources)


def bootstrap_interval(blocks, gates):
    """Resample map/seed blocks within each fixed map, retaining all countries/swaps."""
    maps = defaultdict(list)
    for (map_name, _seed), value in sorted(blocks.items()):
        maps[map_name].append(value)
    enough = len(maps) >= gates['minimumMaps'] and all(len(values) >= gates['minimumSeedsPerMap'] for values in maps.values())
    if not enough:
        return None
    rng = random.Random(gates['bootstrapSeed'])
    samples = []
    for _ in range(gates['bootstrapReplicates']):
        selected = [rng.choice(values) for values in maps.values() for _ in values]
        samples.append(sum(selected) / len(selected))
    samples.sort()
    tail = (1 - gates['confidence']) / 2
    return [samples[int(tail * (len(samples) - 1))], samples[int((1 - tail) * (len(samples) - 1))]]


def compare(control, trial, plan, hypothesis):
    require(control['candidate'] == plan['controlCommit'], 'Control is not the preregistered C18 bot')
    require(control['config'] == trial['config'], 'Opponent, engine, runner, resources or settings differ')
    require(control['games'].keys() == trial['games'].keys(), 'Unpaired scenario schedule')
    require(control['scenarioResources'] == trial['scenarioResources'], 'Map or terrain resources differ')
    require(hypothesis in plan['hypotheses'], 'Unknown preregistered hypothesis')
    target = set(plan['hypotheses'][hypothesis]['targetCountries'])
    gates = plan['gates']
    require(target and target <= set(plan['countries']), 'Invalid hypothesis target')
    deltas, target_deltas = defaultdict(list), defaultdict(list)
    for key, old in control['games'].items():
        new = trial['games'][key]
        value = int(new['result'] == 'candidate-win') - int(old['result'] == 'candidate-win')
        block = (key[2], key[3])
        deltas[block].append(value)
        if old['candidateCountry'] in target:
            target_deltas[block].append(value)
    block_means = lambda values: {k: sum(v) / len(v) for k, v in values.items()}
    interval = bootstrap_interval(block_means(deltas), gates)
    target_interval = bootstrap_interval(block_means(target_deltas), gates)
    old_games, new_games = list(control['games'].values()), list(trial['games'].values())
    old_total, new_total = counts(old_games), counts(new_games)
    delta = new_total['winRate'] - old_total['winRate']
    target_delta = counts([g for g in new_games if g['candidateCountry'] in target])['winRate'] - counts(
        [g for g in old_games if g['candidateCountry'] in target])['winRate']
    groups, regressions, strength_failures = {}, [], []
    if new_total['winRate'] < gates['overallWinRate']:
        strength_failures.append('overall')
    for field, minimum in [('candidateCountry', gates['countryWinRate']), ('map', gates['mapWinRate'])]:
        groups[field] = {}
        for name in sorted({g[field] for g in new_games}):
            old = counts([g for g in old_games if g[field] == name])
            new = counts([g for g in new_games if g[field] == name])
            change = new['winRate'] - old['winRate']
            groups[field][name] = dict(control=old, trial=new, delta=change)
            if change < -gates['maximumGroupRegression'] - 1e-12:
                regressions.append(f'{field}:{name}')
            if new['winRate'] < minimum:
                strength_failures.append(f'{field}:{name}')
    allowed = {tuple(value.rsplit(':', 1)) for name in plan['qualificationSets']
               for value in plan['scenarioSets'][name].values()}
    observed = {(m, str(s)) for m, s in deltas}
    qualification = observed == allowed
    enough = interval is not None and target_interval is not None
    non_regression = (qualification and enough and not regressions and not strength_failures and
                      delta >= gates['minimumOverallDelta'] and interval[0] >= gates['minimumOverallDelta'])
    primary = control['config']['baselineCommit'] == plan['primaryBaselineCommit']
    promising = (primary and non_regression and target_delta >= gates['minimumTargetDelta'] and target_interval[0] > 0)
    negative = bool(regressions or strength_failures or delta < gates['minimumOverallDelta'])
    verdict = 'promising' if promising else 'regression' if negative else 'non_regression' if non_regression and not primary else 'inconclusive'
    return dict(format=1, hypothesis=hypothesis, verdict=verdict, controlCommit=control['candidate'],
                trialCommit=trial['candidate'], baseline=control['config']['baselineCommit'],
                baselineProfile=control['config']['baselineProfile'], control=old_total, trial=new_total,
                overallWinRateDelta=delta, targetWinRateDelta=target_delta,
                overallDeltaInterval=interval, targetDeltaInterval=target_interval,
                enoughScenarioBlocks=enough, qualificationSchedule=qualification,
                primaryOpponent=primary, nonRegressionGatePassed=bool(non_regression),
                scenarioBlocks=len(deltas), targetCountries=sorted(target), groups=groups,
                regressions=regressions, strengthFailures=strength_failures,
                sources=dict(control=control['sources'], trial=trial['sources']), gates=gates,
                limitations=['Intervals condition on these fixed maps; they are not unseen-map or human win rates.',
                             'All country pairs and both spawn swaps remain inside each resampled map/seed block.',
                             'Archive hashes do not replace verification of raw artifacts and receipts.',
                             'Promising does not prove mechanism use, direct superiority over C18, or release readiness.'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--hypothesis', required=True)
    parser.add_argument('--control', type=Path, nargs='+', required=True)
    parser.add_argument('--trial', type=Path, nargs='+', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--require-improvement', action='store_true')
    parser.add_argument('--require-non-regression', action='store_true')
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_text())
        result = compare(load_archives(args.control, plan), load_archives(args.trial, plan), plan, args.hypothesis)
        result['planSha256'] = hashlib.sha256(args.plan.read_bytes()).hexdigest()
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({k: result[k] for k in ('verdict', 'overallWinRateDelta', 'targetWinRateDelta', 'scenarioBlocks')}))
        if args.require_improvement and result['verdict'] != 'promising':
            raise SystemExit(2)
        if args.require_non_regression and not result['nonRegressionGatePassed']:
            raise SystemExit(2)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f'Invalid evaluation: {error}\n')
