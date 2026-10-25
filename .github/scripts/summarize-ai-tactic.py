"""Verify and retain preregistered P1 direct matches, including unsuccessful trials."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

CONTROL = 'c18f77650e40b668064bdb913a75bebfa278f42b'
MAPS = ('mp08t2', 'tn01t2')
PAIRS = (('Arabs', 'Arabs'), ('Russians', 'Russians'), ('Arabs', 'Russians'),
         ('Russians', 'Arabs'), ('Arabs', 'Americans'), ('Russians', 'Americans'),
         ('Americans', 'Arabs'), ('Americans', 'Russians'))
SETTINGS = dict(maxTicks=27000, sampleTicks=900, credits=10000, unitCount=0, gameSpeed=3,
                engineDifficulty=4, pairedSpawnSwap=True, pairedPlayerOrderSwap=True,
                simulationTicksPerSecond=15, shortGame=True, superWeapons=False,
                crates=False, engineStalemateDetection=False)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identity(game):
    return (game['candidateCountry'], game['baselineCountry'],
            re.sub(r'\.(map|mpr)$', '', game['map']), game['seed'], game['swapped'])


def schedule_keys(schedule):
    require(schedule in ('pilot', 'development'), 'Unknown P1 schedule')
    pairs = PAIRS[:2] if schedule == 'pilot' else PAIRS
    seeds = (610101,) if schedule == 'pilot' else (610101, 610202, 610303)
    return {(a, b, m, s, swap) for a, b in pairs for m in MAPS for s in seeds for swap in (False, True)}


def counts(games):
    tally = Counter(g['result'] for g in games)
    wins, losses, draws = (tally[k] for k in ('candidate-win', 'baseline-win', 'draw'))
    n = len(games)
    return dict(games=n, wins=wins, losses=losses, draws=draws, errors=0,
                winRate=wins / n, decisiveWinRate=wins / (wins + losses) if wins + losses else None,
                scoreWithHalfDraws=(wins + draws / 2) / n)


def observations(match, side):
    specialty = match['telemetry'].get('specialty') or {}
    production = specialty.get('production')
    shots = specialty.get('shots')
    damage = specialty.get('damageBySourceType')
    samples = [s['players'][side] for s in match.get('samples', [])]
    escorts = [m['units'] for s in samples for m in s.get('missions', []) if m['name'] == 'dogEscort']
    distances = []
    for sample in samples:
        dogs = [u for u in sample.get('unitDetails', []) if u['name'] == 'DOG']
        tanks = [u for u in sample.get('unitDetails', []) if u['name'] == 'HTNK']
        distances.extend(min(((d['x'] - t['x']) ** 2 + (d['y'] - t['y']) ** 2) ** .5 for t in tanks)
                         for d in dogs if tanks)
    result = dict(produced={name: len(production[side].get(name, {}).get('factoryProducedTicks', []))
                          if production is not None else None for name in ('E2', 'DOG', 'HTNK', 'HARV')},
                firstTankTick=min(production[side].get('HTNK', {}).get('factoryProducedTicks', []), default=None)
                    if production is not None else None,
                tankShots=sum(v['count'] for v in shots[side].get('HTNK', {}).values()) if shots is not None else None,
                firstTankShotTick=min((v['firstTick'] for v in shots[side].get('HTNK', {}).values()), default=None)
                    if shots is not None else None,
                dogShots=sum(v['count'] for v in shots[side].get('DOG', {}).values()) if shots is not None else None,
                damageBySourceType={name: damage[side].get(name, {}) for name in ('E2', 'DOG', 'HTNK')}
                    if damage is not None else None,
                sampleCount=len(samples), maxSampledEscort= max(escorts) if escorts else None,
                sampledDogTankDistances=len(distances),
                meanSampledDogTankDistance=sum(distances) / len(distances) if distances else None,
                finalSampleForce=samples[-1].get('forceComposition') if samples else None)
    if 'mobility' in match['telemetry']:
        result['mobility'] = match['telemetry']['mobility']['players'][side]
        for name in ('HTK', 'JUMPJET'):
            result['produced'][name] = len(production[side].get(name, {}).get('factoryProducedTicks', [])) if production is not None else None
            if result['damageBySourceType'] is not None:
                result['damageBySourceType'][name] = damage[side].get(name, {})
        result['firstFlakTrackTick'] = min(production[side].get('HTK', {}).get('factoryProducedTicks', []), default=None) if production is not None else None
        result['flakTrackAirShots'] = sum(v['count'] for weapon, v in shots[side].get('HTK', {}).items() if 'AA' in weapon.upper()) if shots is not None else None
    return result


def verify(paths, candidate, baseline=CONTROL, schedule='pilot'):
    require(all(re.fullmatch(r'[a-f0-9]{40}', ref) for ref in (candidate, baseline)), 'Freeze full commits')
    expected, games, raw_index, config, resources = schedule_keys(schedule), {}, [], None, {}
    for path in paths:
        raw = path.read_bytes()
        report = json.loads(raw)
        require(report['candidate']['commit'] == candidate and report['baseline']['commit'] == baseline,
                'Frozen candidate/baseline mismatch')
        require(report['candidate']['profile'] == report['baseline']['profile'] == 'brutal', 'Profiles differ')
        # Baselines are loaded from git archive; older raw reports have no dirty field for them.
        require(report['candidate']['dirty'] is False and report['baseline'].get('dirty', False) is False and
                report['engineDirty'] is False, 'Dirty code cannot be compared')
        require(re.fullmatch(r'[a-f0-9]{40}', report['engineCommit']) is not None, 'Engine must be frozen')
        require(report['settings'] == SETTINGS, 'Unequal or unexpected game settings')
        current = {k: report[k] for k in ('engineCommit', 'settings', 'resources')}
        require(config is None or config == current, 'Reports mix engine, resources or settings')
        config = current
        for match in report['matches']:
            require(type(match['seed']) is int and type(match['swapped']) is bool, 'Invalid seed/swap')
            key = identity(match)
            require(key in expected and key not in games, 'Unexpected or duplicate game')
            require(type(match['telemetry'].get('errorCount')) is int and match['telemetry']['errorCount'] == 0,
                    'Runtime error or missing error telemetry; cannot count as a draw')
            require(match['result'] in ('candidate-win', 'baseline-win', 'draw'), 'Invalid result')
            require(type(match['ticks']) is int and 0 < match['ticks'] <= SETTINGS['maxTicks'], 'Invalid ticks')
            require((match['result'] == 'draw' and match['reason'] == 'tick-limit' and match['ticks'] == SETTINGS['maxTicks']) or
                    (match['result'] != 'draw' and match['reason'] == 'engine-victory-conditions'), 'Invalid outcome reason')
            proof = {k: match[k] for k in ('mapSha256', 'terrainSha256')}
            require(all(re.fullmatch(r'[a-f0-9]{64}', v) for v in proof.values()), 'Missing resource digest')
            map_name = key[2]
            require(map_name not in resources or resources[map_name] == proof, 'Map/terrain resources changed')
            resources[map_name] = proof
            game = {k: match[k] for k in ('candidateCountry', 'baselineCountry', 'map', 'seed', 'swapped', 'result', 'reason', 'ticks')}
            game.update(errorCount=0, startingLocations=match['startingLocations'],
                        candidatePlayerName=match['candidatePlayerName'], baselinePlayerName=match['baselinePlayerName'],
                        observations=[observations(match, side) for side in (0, 1)])
            games[key] = game
        raw_index.append(dict(file=path.name, bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest()))
    require(set(games) == expected, f'Incomplete P1 schedule: {len(games)}/{len(expected)} games')
    for key, game in games.items():
        paired = games[(*key[:-1], not key[-1])]
        require(game['startingLocations'] == paired['startingLocations'][::-1] and
                game['candidatePlayerName'] == paired['baselinePlayerName'] and
                game['baselinePlayerName'] == paired['candidatePlayerName'], 'Unequal paired starts or player slots')
    values = [games[key] for key in sorted(games)]
    totals = counts(values)
    result = dict(format=1, kind='direct-current-bot-tactic', schedule=schedule,
                candidateCommit=candidate, baselineCommit=baseline, profiles=['brutal', 'brutal'],
                config=config, mapResources=resources, rawReports=raw_index, totals=totals, games=values,
                byCountry={c: counts([g for g in values if g['candidateCountry'] == c]) for c in sorted({g['candidateCountry'] for g in values})},
                byMap={m: counts([g for g in values if identity(g)[2] == m]) for m in MAPS},
                screeningPositive=totals['wins'] > totals['losses'], qualified=False,
                notes=['Development only; exposed seeds and at most two maps cannot establish qualification.',
                       'Dog counts, damage and distances include scouts, not only escorts; production may diverge after micro changes.',
                       'Max escort and force state are sampled every 900 ticks. No sampled escort does not prove zero assignment.',
                       'Missing observations remain null. Dog death does not establish tank-shot interception.'])
    if candidate == baseline:
        result['controlSanity'] = totals['wins'] == totals['losses']
        result['screeningPositive'] = False
        result['notes'].append('Self-play is an integrity control: symmetric outcomes are not an improvement or qualification.')
    return result


def write(result, directory):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    t = result['totals']
    baseline_label = 'C18' if result['baselineCommit'] == CONTROL else 'frozen bot ' + result['baselineCommit'][:7]
    control = result.get('controlSanity')
    passed = result.get('controlSanity', result['screeningPositive'])
    verdict = ('symmetric self-play control' if control else 'asymmetric self-play control') if control is not None else ('positive' if passed else 'not improved')
    lines = [f'# P1 direct comparison with {baseline_label}', '', f"Candidate `{result['candidateCommit']}` vs `{result['baselineCommit']}`.", '',
             f"{t['games']} games: {t['wins']}W / {t['losses']}L / {t['draws']}D / 0E. Wins/all games {t['winRate']:.2%}; score with half draws {t['scoreWithHalfDraws']:.2%}.", '',
             f"Development screen: {verdict}. **Not qualified.**", '',
             '| Country | W | L | D | Wins/all |', '| --- | ---: | ---: | ---: | ---: |']
    for name, row in result['byCountry'].items():
        lines.append(f"| {name} | {row['wins']} | {row['losses']} | {row['draws']} | {row['winRate']:.2%} |")
    lines.extend(['', *result['notes'], ''])
    (directory / 'report.md').write_text('\n'.join(lines))
    (directory / 'strength-assessment.json').write_text(json.dumps(dict(kind=result['kind'],
        passed=passed, qualified=False, completed=t['games'], errors=0,
        **({'controlSanity': control} if control is not None else {}),
        failure=None if passed else 'Self-play outcomes are asymmetric' if control is not None else
            'Candidate wins do not exceed current C18 wins' if result['baselineCommit'] == CONTROL else
            'Candidate wins do not exceed the previous frozen bot wins'), indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reports', type=Path, nargs='+')
    parser.add_argument('--candidate-ref', required=True)
    parser.add_argument('--baseline-ref', default=CONTROL)
    parser.add_argument('--schedule', choices=('pilot', 'development'), default='pilot')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--require-positive', action='store_true')
    args = parser.parse_args()
    result = verify(args.reports, args.candidate_ref, args.baseline_ref, args.schedule)
    write(result, args.out)
    print(json.dumps(result['totals']))
    if args.require_positive and not result.get('controlSanity', result['screeningPositive']):
        raise SystemExit(2)
