"""Assess direct candidate/current-bot matches after raw matrix verification."""
import argparse
from collections import defaultdict
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('paired_ai', Path(__file__).with_name('compare-ai-evaluations.py'))
paired = importlib.util.module_from_spec(spec)
spec.loader.exec_module(paired)


def direct_assessment(reports, plan):
    config, games = None, {}
    for report in reports:
        cfg = report['config']
        current = {key: cfg[key] for key in (*paired.COMPARABLE, 'candidateCommit')}
        if config is not None:
            paired.require(current == config, 'Direct reports mix versions, profiles, resources or settings')
        config = current
        paired.require(cfg['candidateProfile'] == cfg['baselineProfile'] == 'brutal', 'Direct profiles must match')
        paired.require(cfg['countries'] == plan['countries'], 'Direct country schedule differs')
        paired.require(all(cfg.get(k) == v for k, v in plan['settings'].items()), 'Direct rules differ')
        scenarios = {(paired.normalized_map(m), int(seed)) for m, seed in report['scenarios']}
        expected = {(a, b, m, seed, swapped) for a in cfg['countries'] for b in cfg['countries'] if a != b
                    for m, seed in scenarios for swapped in (False, True)}
        seen = set()
        for game in report['games']:
            key = paired.identity(game)
            paired.require(key in expected and key not in seen and key not in games, 'Missing or duplicate direct identities')
            paired.require(game['result'] in ('candidate-win', 'baseline-win', 'draw'), 'Invalid direct result')
            seen.add(key); games[key] = game
        paired.require(len(scenarios) == 3 and seen == expected, 'Incomplete direct matrix')
        actual = paired.counts(report['games'])
        paired.require(all(actual[k] == report['totals'][k] for k in ('wins', 'losses', 'draws', 'games')), 'Direct totals mismatch')
    paired.require(config is not None, 'No direct reports')
    values = list(games.values())
    totals = paired.counts(values)
    score = (totals['wins'] + totals['draws'] / 2) / totals['games']
    blocks = defaultdict(list)
    for key, game in games.items():
        blocks[key[2], key[3]].append(1 if game['result'] == 'candidate-win' else .5 if game['result'] == 'draw' else 0)
    interval = paired.bootstrap_interval({k: sum(v) / len(v) for k, v in blocks.items()}, plan['gates'])
    allowed = {(m, int(seed)) for label in plan['qualificationSets']
               for m, seed in (value.split(':') for value in plan['scenarioSets'][label].values())}
    qualification = set(blocks) == allowed
    qualified = qualification and interval is not None and interval[0] > .5
    positive = score > .5 and totals['wins'] > totals['losses']
    return dict(kind='direct-current-bot', candidate=config['candidateCommit'], baseline=config['baselineCommit'],
        totals=totals, scoreWithHalfDraws=score, scoreInterval=interval, scenarioBlocks=len(blocks),
        qualificationSchedule=qualification, qualified=bool(qualified), screeningPositive=positive,
        verdict='qualification-positive' if qualified else 'development-positive' if positive else 'not-improved',
        byCountry={c: paired.counts([g for g in values if g['candidateCountry'] == c]) for c in config['countries']},
        byMap={m: paired.counts([g for g in values if g['map'] == m]) for m in sorted({g['map'] for g in values})},
        notes=['Input must first pass raw manifest/report/receipt verification; this command does not replace it.',
               'The primary win rate includes draws. Score with half draws is a separately named direct-match metric.',
               'Development-positive is a screening signal, not evidence of qualification or human strength.',
               'Historical 80/70/70 thresholds are retained for old-opponent regressions, not reused for peer matches.'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--additional', type=Path, nargs='*', default=[])
    parser.add_argument('--plan', type=Path, default=Path(__file__).resolve().parents[2] / 'docs/ai-vanilla-evaluation-plan.json')
    args = parser.parse_args()
    report_paths = [args.directory / 'results.json', *args.additional]
    assessment = direct_assessment([json.loads(p.read_text()) for p in report_paths], json.loads(args.plan.read_text()))
    (args.directory / 'direct-assessment.json').write_text(json.dumps(assessment, indent=2) + '\n')
    # Replace the disabled historical threshold annotation with the actual direct
    # gate. Keep the complete matrix, country/map results and observed events.
    report = args.directory / 'report.md'
    text = report.read_text().split('\nStrength thresholds')[0]
    text += '\n\n## Direct comparison with current bot\n\n'
    text += f"Verdict: **{assessment['verdict']}**. Score with half draws: {assessment['scoreWithHalfDraws']:.2%}. "
    text += f"Primary wins/valid games: {assessment['totals']['winRate']:.2%}.\n\n"
    text += 'Development-positive only passes the development screen. Qualification requires all registered seed sets and a score interval lower bound above 50%; partial results cannot prove the tactic is stronger.\n'
    report.write_text(text)
    gate = dict(kind=assessment['kind'], passed=assessment['screeningPositive'], qualified=assessment['qualified'],
                verdict=assessment['verdict'], thresholds=dict(directScoreGreaterThan=.5),
                failures=[] if assessment['screeningPositive'] else ['Direct candidate wins do not exceed current bot wins'])
    (args.directory / 'strength-assessment.json').write_text(json.dumps(gate, indent=2) + '\n')
    print(json.dumps({k: assessment[k] for k in ('verdict', 'totals', 'scoreWithHalfDraws', 'qualified')}))
    if not gate['passed']:
        raise SystemExit(2)
