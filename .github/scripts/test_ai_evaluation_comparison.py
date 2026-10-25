"""Synthetic data tests for comparison validity, correlation and regression gates."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


comparison = module('ai_comparison', 'compare-ai-evaluations.py')
scenario = module('ai_scenario', 'ai-evaluation-scenario.py')


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = json.loads((ROOT / 'docs/ai-vanilla-evaluation-plan.json').read_text())

    def archive(self, name, candidate=None, evaluation_set='qualification_a', outcome=None, baseline=2):
        directory = self.root / name
        directory.mkdir()
        cfg = {k: 'a' * 64 for k in comparison.COMPARABLE}
        cfg.update(self.plan['settings'], countries=self.plan['countries'], sampleTicks=900,
                   candidateCommit=candidate or self.plan['controlCommit'], engineCommit='e' * 40,
                   baselineCommit=self.plan['baselines'][baseline]['commit'],
                   baselineProfile=self.plan['baselines'][baseline]['profile'], bunVersion='1.3.14')
        scenarios = [value.split(':') for value in self.plan['scenarioSets'][evaluation_set].values()]
        games = []
        for a in self.plan['countries']:
            for b in self.plan['countries']:
                if a == b:
                    continue
                for m, seed in scenarios:
                    for swap in (False, True):
                        result = outcome(a) if outcome else 'candidate-win'
                        games.append(dict(candidateCountry=a, baselineCountry=b, map=m + '.map', seed=int(seed), swapped=swap,
                                          result=result, ticks=27000 if result == 'draw' else 9000,
                                          reason='tick-limit' if result == 'draw' else 'engine-victory-conditions', errorCount=0))
        metadata = dict(config=cfg, runId=name, gamesFile='games.jsonl',
                        invariants=dict(receiptsVerified=True, errors=0, missing=0, mixedVersions=False),
                        scenarios=[(m, int(s)) for m, s in scenarios])
        metadata['manifestReceipts'] = [dict(config=dict(scenarios=[dict(map=m, seed=int(s),
            mapSha256=hashlib.sha256(m.encode()).hexdigest(), terrainSha256='d' * 64, terrainFile='isotemp.mix')]))
            for m, s in scenarios]
        self.write(directory, metadata, games)
        return directory / 'archive.json'

    def write(self, directory, metadata, games):
        raw = ''.join(json.dumps(game) + '\n' for game in games).encode()
        (directory / 'games.jsonl').write_bytes(raw)
        metadata['archivedFilesSha256'] = {'games.jsonl': hashlib.sha256(raw).hexdigest()}
        metadata['totals'] = comparison.counts(games)
        (directory / 'archive.json').write_text(json.dumps(metadata))

    def dataset(self, prefix, candidate=None, outcome=None):
        return comparison.load_archives([self.archive(prefix + str(i), candidate, label, outcome)
                                         for i, label in enumerate(self.plan['qualificationSets'])], self.plan)

    def test_identical_control_is_not_claimed_as_an_improvement(self):
        control = self.dataset('control')
        trial = self.dataset('trial', 'b' * 40)
        result = comparison.compare(control, trial, self.plan, 'rhino_dog_micro')
        self.assertEqual(result['verdict'], 'inconclusive')
        self.assertEqual(result['overallWinRateDelta'], 0)
        self.assertTrue(result['qualificationSchedule'])
        self.assertEqual(result['scenarioBlocks'], 9)

    def test_one_seed_per_map_cannot_produce_a_confident_win(self):
        control = comparison.load_archives([self.archive('control', outcome=lambda a: 'draw')], self.plan)
        trial = comparison.load_archives([self.archive('trial', 'b' * 40)], self.plan)
        result = comparison.compare(control, trial, self.plan, 'rhino_dog_micro')
        self.assertEqual(result['verdict'], 'inconclusive')
        self.assertIsNone(result['targetDeltaInterval'])
        self.assertFalse(result['enoughScenarioBlocks'])

    def test_strong_paired_effect_is_promising_only_on_full_registered_schedule(self):
        target = self.plan['hypotheses']['rhino_dog_micro']['targetCountries']
        control = self.dataset('control', outcome=lambda a: 'draw' if a in target else 'candidate-win')
        trial = self.dataset('trial', 'b' * 40)
        result = comparison.compare(control, trial, self.plan, 'rhino_dog_micro')
        self.assertEqual(result['verdict'], 'promising')
        self.assertGreater(result['targetDeltaInterval'][0], 0)
        self.assertEqual(result['trial']['games'], 1296)

    def test_high_overall_rate_does_not_hide_one_country_regression(self):
        control = self.dataset('control')
        trial = self.dataset('trial', 'b' * 40, lambda a: 'baseline-win' if a == 'French' else 'candidate-win')
        result = comparison.compare(control, trial, self.plan, 'rhino_dog_micro')
        self.assertGreater(result['trial']['winRate'], .8)
        self.assertEqual(result['verdict'], 'regression')
        self.assertIn('candidateCountry:French', result['strengthFailures'])

    def test_changed_engine_or_opponent_cannot_be_compared(self):
        control = self.dataset('control')
        for field in ('engineSourceSha256', 'baselineCommit', 'runnerSourceSha256', 'baselineProfile'):
            trial = copy.deepcopy(control)
            trial['config'][field] = 'different'
            with self.assertRaisesRegex(ValueError, 'differ'):
                comparison.compare(control, trial, self.plan, 'rhino_dog_micro')

    def test_tampered_game_file_and_missing_receipts_are_rejected(self):
        path = self.archive('control')
        (path.parent / 'games.jsonl').write_text((path.parent / 'games.jsonl').read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'hash'):
            comparison.load_archives([path], self.plan)
        path = self.archive('other')
        metadata = json.loads(path.read_text()); metadata['invariants']['receiptsVerified'] = False
        path.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, 'receipt'):
            comparison.load_archives([path], self.plan)

    def test_same_map_name_with_different_resource_hash_is_not_comparable(self):
        control = self.dataset('control')
        trial = copy.deepcopy(control)
        first = next(iter(trial['scenarioResources']))
        trial['scenarioResources'][first]['mapSha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, 'resources differ'):
            comparison.compare(control, trial, self.plan, 'rhino_dog_micro')

    def test_missing_swap_and_runtime_error_are_not_draws(self):
        for variant in ('missing', 'error', 'duplicate'):
            path = self.archive(variant)
            metadata = json.loads(path.read_text())
            games = [json.loads(line) for line in (path.parent / 'games.jsonl').read_text().splitlines()]
            if variant == 'missing':
                games.pop()
            elif variant == 'error':
                games[0].update(result='draw', reason='tick-limit', ticks=27000, errorCount=1)
            else:
                games.append(games[0])
            self.write(path.parent, metadata, games)
            with self.assertRaises(ValueError):
                comparison.load_archives([path], self.plan)

    def test_repeated_archive_does_not_inflate_sample_size(self):
        path = self.archive('control')
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            comparison.load_archives([path, path], self.plan)

    def test_original_normal_profile_remains_explicit_and_valid(self):
        data = comparison.load_archives([self.archive('original', baseline=0)], self.plan)
        self.assertEqual(data['config']['baselineProfile'], 'normal')

    def test_saturated_original_opponent_only_requires_non_regression(self):
        control = comparison.load_archives([self.archive('old' + str(i), evaluation_set=label, baseline=0)
            for i, label in enumerate(self.plan['qualificationSets'])], self.plan)
        trial = comparison.load_archives([self.archive('new' + str(i), candidate='b' * 40, evaluation_set=label, baseline=0)
            for i, label in enumerate(self.plan['qualificationSets'])], self.plan)
        result = comparison.compare(control, trial, self.plan, 'rhino_dog_micro')
        self.assertEqual(result['verdict'], 'non_regression')
        self.assertTrue(result['nonRegressionGatePassed'])
        self.assertEqual(result['targetWinRateDelta'], 0)

    def test_preregistered_scenarios_keep_legacy_defaults_and_disjoint_holdouts(self):
        self.assertEqual(scenario.scenario(self.plan, 'regression', 'short'), 'mp08t2:10111')
        self.assertEqual(scenario.scenario(self.plan, 'qualification_c', 'long'), 'mp11t2:730303')
        changed = copy.deepcopy(self.plan)
        changed['scenarioSets']['qualification_a']['short'] = 'mp08t2:10111'
        with self.assertRaisesRegex(ValueError, 'Reused'):
            scenario.scenario(changed, 'qualification_a', 'short')
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            scenario.scenario(self.plan, 'made_up', 'short')


if __name__ == '__main__':
    unittest.main()
