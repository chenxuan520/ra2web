import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('report', Path(__file__).with_name('summarize-ai-matrix.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class CountryReportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        countries = ['Americans', 'Alliance', 'French', 'Germans', 'British', 'Africans', 'Arabs', 'Confederation', 'Russians']
        settings = dict(maxTicks=27000, sampleTicks=900, credits=10000, unitCount=0,
                        engineDifficulty=4, pairedSpawnSwap=True, pairedPlayerOrderSwap=True,
                        shortGame=True, superWeapons=False, crates=False, gameSpeed=3,
                        engineStalemateDetection=False, simulationTicksPerSecond=15)
        for index, map_name in enumerate(['mp08t2', 'tn01t2', 'mp11t2']):
            shard = self.root / f'shard-{index}'
            (shard / 'jobs').mkdir(parents=True)
            scenario = dict(map=map_name, seed=index + 1, mapSha256='map', terrainSha256='terrain')
            config = dict(candidateCommit='new', baselineCommit='old', engineCommit='engine',
                          candidateProfile='brutal', baselineProfile='brutal', countries=countries,
                          iniSha256='rules', customIniSha256='custom', scenarios=[scenario],
                          **{k: settings[k] for k in ['maxTicks', 'sampleTicks', 'credits', 'unitCount']})
            fingerprint = hashlib.sha256(json.dumps(config, separators=(',', ':')).encode()).hexdigest()
            jobs = []
            for country in countries:
                for opponent in countries:
                    if country == opponent:
                        continue
                    job = dict(id=f'{country}-vs-{opponent}', candidateCountry=country, baselineCountry=opponent)
                    jobs.append(job)
                    matches = [dict(candidateCountry=country, baselineCountry=opponent, map=map_name + '.map',
                                    seed=index + 1, mapSha256='map', terrainSha256='terrain', swapped=swap,
                                    result='candidate-win', reason='engine-victory-conditions', ticks=5000,
                                    telemetry=dict(errorCount=0)) for swap in [False, True]]
                    data = dict(candidate=dict(commit='new', profile='brutal', dirty=False),
                                baseline=dict(commit='old', profile='brutal'), engineCommit='engine', engineDirty=False,
                                settings=settings, resources=dict(iniSha256='rules', customIniSha256='custom'), matches=matches)
                    path = shard / 'jobs' / (job['id'] + '.json')
                    path.write_text(json.dumps(data))
                    receipt = dict(fingerprint=fingerprint, reportSha256=hashlib.sha256(path.read_bytes()).hexdigest())
                    path.with_suffix('.verified.json').write_text(json.dumps(receipt))
            (shard / 'manifest.json').write_text(json.dumps(dict(config=config, fingerprint=fingerprint, countryLabels={c: c for c in countries}, jobs=jobs)))
            (shard / 'summary.json').write_text(json.dumps(dict(fingerprint=fingerprint, failedJobs={}, total=dict(pending=0, errors=0))))

    def test_complete_matrix_is_counted_once(self):
        report.aggregate(self.root, self.root / 'result')
        data = json.loads((self.root / 'result/results.json').read_text())
        self.assertEqual(data['totals'], dict(wins=432, losses=0, draws=0, games=432, winRate=1.0))
        self.assertEqual(data['matrix']['Americans']['French']['games'], 6)
        self.assertEqual(data['byMap']['mp08t2.map']['games'], 144)
        self.assertEqual(data['byCountry']['Americans']['games'], 48)
        self.assertEqual(data['features']['desolatorsBoarded']['coveredGames'], 0)
        self.assertIn('not provided', (self.root / 'result/report.md').read_text())

    def test_feature_events_keep_side_and_causality_distinctions(self):
        telemetry = dict(harassmentLaunches=[3, 99], ordersByType=[dict(Capture=12), {}], specialty=dict(
            production=[dict(DESO=dict(factoryProducedTicks=[1, 2]), GTGCAN=dict(readyTicks=[3])), {}],
            shots=[dict(GTGCAN=dict(GrandCannonWeapon=dict(count=8))), {}],
            deployments=[dict(player=0, name='DESO', deployed=True), dict(player=0, name='DESO', deployed=False),
                         dict(player=1, name='DESO', deployed=True)],
            ownershipChanges=[dict(newSide=0, previousSide=1), dict(newSide=0, previousSide=-1), dict(newSide=1, previousSide=0)],
            crushKills=[dict(player=0, victimSide=1), dict(player=0, victimSide=0)],
            transportEvents=[dict(player=0, event=event, destroyed=destroyed, passengers=[dict(name='DESO')])
                             for event, destroyed in [('EnterObject', False), ('LeaveTransport', False), ('LeaveTransport', True)]],
            radiation=dict(damageHitPointsByVictim=[3, 7])))
        values = report.feature_observations(dict(telemetry=telemetry))
        self.assertEqual(values['desolatorsProduced'], 2)
        self.assertEqual(values['desolatorDeployments'], 1)
        self.assertEqual(values['grandCannonShots'], 8)
        self.assertEqual(values['surplusRaidDetachments'], 3)
        self.assertEqual(values['captureOrders'], 12)
        self.assertEqual(values['enemyObjectsAcquiredCauseUnspecified'], 1)
        self.assertEqual(values['neutralObjectsAcquiredCauseUnspecified'], 1)
        self.assertEqual(values['enemyCrushKills'], 1)
        self.assertEqual(values['desolatorsBoarded'], 1)
        self.assertEqual(values['desolatorUnloadsFromIntactTransport'], 1)
        self.assertEqual(values['ownerlessRadiationDamageToCandidate'], 3)
        self.assertEqual(values['ownerlessRadiationDamageToBaseline'], 7)

    def test_missing_scenario_is_rejected(self):
        (self.root / 'shard-1/manifest.json').unlink()
        with self.assertRaisesRegex(ValueError, 'three scenario'):
            report.aggregate(self.root, self.root / 'result')

    def test_changed_report_requires_matching_receipt(self):
        path = self.root / 'shard-0/jobs/Americans-vs-French.json'
        path.write_text(path.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'receipt'):
            report.aggregate(self.root, self.root / 'result')

    def test_manifest_change_is_not_silently_accepted(self):
        path = self.root / 'shard-0/manifest.json'
        data = json.loads(path.read_text()); data['config']['credits'] = 20000
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            report.aggregate(self.root, self.root / 'result')

    def test_partial_scenario_is_not_a_success(self):
        path = self.root / 'shard-0/summary.json'
        data = json.loads(path.read_text()); data['total']['pending'] = 1
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, 'pending'):
            report.aggregate(self.root, self.root / 'result')

    def test_runtime_error_is_not_counted_as_a_win(self):
        path = self.root / 'shard-0/jobs/Americans-vs-French.json'
        data = json.loads(path.read_text()); data['matches'][0]['telemetry']['errorCount'] = 1
        path.write_text(json.dumps(data))
        receipt = path.with_suffix('.verified.json'); proof = json.loads(receipt.read_text())
        proof['reportSha256'] = hashlib.sha256(path.read_bytes()).hexdigest(); receipt.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'Invalid game'):
            report.aggregate(self.root, self.root / 'result')

    def rewrite_matches(self, paths, change):
        for path in paths:
            if path.name.endswith('.verified.json'):
                continue
            data = json.loads(path.read_text())
            for match in data['matches']:
                change(match)
            path.write_text(json.dumps(data))
            receipt = path.with_suffix('.verified.json')
            proof = json.loads(receipt.read_text())
            proof['reportSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            receipt.write_text(json.dumps(proof))

    def test_country_strength_gate_does_not_hide_weak_countries_in_a_high_overall_rate(self):
        self.rewrite_matches(self.root.glob('shard-*/jobs/French-vs-*.json'),
                             lambda match: match.update(result='baseline-win'))
        with self.assertRaisesRegex(ValueError, 'Country French: 0.0%'):
            report.aggregate(self.root, self.root / 'result', .8, .7, .7)
        data = json.loads((self.root / 'result/results.json').read_text())
        self.assertEqual(data['totals']['games'], 432)
        self.assertGreater(data['totals']['winRate'], .8)
        self.assertFalse(json.loads((self.root / 'result/strength-assessment.json').read_text())['passed'])

    def test_map_strength_gate_retains_every_game_instead_of_dropping_the_weak_map(self):
        self.rewrite_matches(self.root.glob('shard-0/jobs/*.json'),
                             lambda match: match.update(result='baseline-win') if not match['swapped'] else None)
        with self.assertRaisesRegex(ValueError, 'Map mp08t2.map: 50.0%'):
            report.aggregate(self.root, self.root / 'result', .8, .7, .7)
        data = json.loads((self.root / 'result/results.json').read_text())
        self.assertGreater(data['totals']['winRate'], .8)
        self.assertTrue(all(row['winRate'] >= .7 for row in data['byCountry'].values()))
        self.assertEqual(data['byMap']['mp08t2.map']['games'], 144)


if __name__ == '__main__':
    unittest.main()
