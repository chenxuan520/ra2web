"""Aggregate scenario shards; refuse mixed versions, missing pairs or invalid games."""
import argparse
import csv
import hashlib
import json
from pathlib import Path


def aggregate(source, destination):
    manifests = sorted(source.rglob('manifest.json'))
    if len(manifests) != 3:
        raise ValueError(f'Expected three scenario manifests, found {len(manifests)}')
    games, config, labels, scenarios = [], None, None, set()
    for manifest_path in manifests:
        manifest = json.loads(manifest_path.read_text())
        digest = hashlib.sha256(json.dumps(manifest['config'], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        if manifest['fingerprint'] != digest:
            raise ValueError('Manifest configuration fingerprint mismatch')
        current = dict(manifest['config'])
        scenario_config = current.pop('scenarios')
        if len(scenario_config) != 1:
            raise ValueError('Each CI shard must contain exactly one map/seed scenario')
        scenario = scenario_config[0]
        key = (scenario['map'], scenario['seed'])
        if key in scenarios:
            raise ValueError('Duplicate scenario shard')
        scenarios.add(key)
        if config is None:
            config, labels = current, manifest['countryLabels']
        if config != current or labels != manifest['countryLabels']:
            raise ValueError('CI shards have different code, resources or settings')
        shard = manifest_path.parent
        summary = json.loads((shard / 'summary.json').read_text())
        if summary['fingerprint'] != manifest['fingerprint'] or summary['failedJobs']:
            raise ValueError('Unverified or failed scenario shard')
        if summary['total']['pending'] or summary['total']['errors']:
            raise ValueError('Scenario shard has pending or invalid games')
        for job in manifest['jobs']:
            path = shard / 'jobs' / (job['id'] + '.json')
            raw = path.read_bytes()
            verified = json.loads((shard / 'jobs' / (job['id'] + '.verified.json')).read_text())
            if verified['fingerprint'] != manifest['fingerprint'] or verified['reportSha256'] != hashlib.sha256(raw).hexdigest():
                raise ValueError('Paired report does not match its verification receipt')
            report = json.loads(raw)
            if (report['candidate']['commit'] != config['candidateCommit'] or
                    report['baseline']['commit'] != config['baselineCommit'] or
                    report['candidate']['profile'] != config['candidateProfile'] or
                    report['baseline']['profile'] != config['baselineProfile'] or
                    report['candidate'].get('dirty') or
                    report['engineCommit'] != config['engineCommit'] or report['engineDirty']):
                raise ValueError('Paired report version mismatch')
            for setting in ('maxTicks', 'sampleTicks', 'credits', 'unitCount'):
                if report['settings'][setting] != config[setting]:
                    raise ValueError('Paired report settings mismatch')
            required = dict(engineDifficulty=4, pairedSpawnSwap=True, pairedPlayerOrderSwap=True,
                            shortGame=True, superWeapons=False, crates=False, gameSpeed=3,
                            engineStalemateDetection=False, simulationTicksPerSecond=15)
            if any(report['settings'].get(k) != v for k, v in required.items()):
                raise ValueError('Paired report game rules mismatch')
            if any(report['resources'].get(k) != config[k] for k in ('iniSha256', 'customIniSha256')):
                raise ValueError('Paired report resource mismatch')
            if len(report['matches']) != 2 or {m['swapped'] for m in report['matches']} != {False, True}:
                raise ValueError('Missing or duplicate spawn swap')
            for match in report['matches']:
                if match['result'] not in ('candidate-win', 'baseline-win', 'draw') or match['telemetry']['errorCount']:
                    raise ValueError('Invalid game cannot be included in win rates')
                if (match['candidateCountry'] != job['candidateCountry'] or
                        match['baselineCountry'] != job['baselineCountry'] or
                        match['seed'] != scenario['seed'] or match['mapSha256'] != scenario['mapSha256'] or
                        match['terrainSha256'] != scenario['terrainSha256']):
                    raise ValueError('Paired report scenario mismatch')
                if match['result'] != 'draw' and match['reason'] != 'engine-victory-conditions':
                    raise ValueError('A winner must be determined by the engine')
                if match['reason'] == 'tick-limit' and match['ticks'] != config['maxTicks']:
                    raise ValueError('A timeout must reach the configured tick limit')
                games.append({key: match[key] for key in ('candidateCountry', 'baselineCountry', 'map', 'seed', 'swapped', 'result', 'ticks')})
    countries = config['countries']
    if len(countries) != 9 or len(games) != 432:
        raise ValueError(f'Expected nine countries and 432 games, found {len(countries)} / {len(games)}')
    identities = {(g['candidateCountry'], g['baselineCountry'], g['map'], g['seed'], g['swapped']) for g in games}
    if len(identities) != 432:
        raise ValueError('Duplicate game identities')
    matrix = {}
    for country in countries:
        matrix[country] = {}
        for opponent in countries:
            if opponent == country:
                continue
            selected = [g for g in games if g['candidateCountry'] == country and g['baselineCountry'] == opponent]
            if len(selected) != 6:
                raise ValueError(f'Expected six games for {country} / {opponent}')
            wins, losses, draws = [sum(g['result'] == result for g in selected) for result in ('candidate-win', 'baseline-win', 'draw')]
            matrix[country][opponent] = dict(wins=wins, losses=losses, draws=draws, games=6, winRate=wins / 6)
    totals = {k: sum(m[k] for row in matrix.values() for m in row.values()) for k in ('wins', 'losses', 'draws', 'games')}
    totals['winRate'] = totals['wins'] / totals['games']
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'results.json').write_text(json.dumps(dict(config=config, scenarios=sorted(scenarios), totals=totals, matrix=matrix, games=games), indent=2) + '\n')
    with (destination / 'matrix.csv').open('w') as stream:
        writer = csv.writer(stream)
        writer.writerow(['candidate', 'opponent', 'wins', 'losses', 'draws', 'games', 'win_rate_including_draws'])
        for country, row in matrix.items():
            for opponent, counts in row.items():
                writer.writerow([labels[country], labels[opponent], *[counts[k] for k in ('wins', 'losses', 'draws', 'games', 'winRate')]])
    lines = ['# AI country tournament', '', f"Candidate `{config['candidateCommit']}` vs `{config['baselineCommit']}`.", '',
             f"432 valid games: {totals['wins']} wins, {totals['losses']} losses, {totals['draws']} draws. Win rate including draws: {totals['winRate']:.1%}.", '',
             'Rows are the candidate bot, columns the frozen baseline. Cells are W/L/D (six games each).', '',
             '| New / old | ' + ' | '.join(labels[c] for c in countries) + ' |',
             '| --- | ' + ' | '.join(['---:'] * len(countries)) + ' |']
    for country in countries:
        cells = ['—' if country == opponent else '/'.join(str(matrix[country][opponent][k]) for k in ('wins', 'losses', 'draws')) for opponent in countries]
        lines.append('| ' + labels[country] + ' | ' + ' | '.join(cells) + ' |')
    lines += ['', 'Timeouts are draws. Errors and missing games fail the report. Country effects, maps and spawn positions limit generalization; these are not human win rates.']
    (destination / 'report.md').write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    aggregate(args.input, args.output)
