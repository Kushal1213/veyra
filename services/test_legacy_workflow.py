"""Regression cases use the actual bundled index, not only uploaded fixtures."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import faiss
import numpy as np
from fastapi.testclient import TestClient
from test_managed_knowledge import service

ROOT = Path(__file__).resolve().parents[1]


class LegacyWorkflowTests(unittest.TestCase):
    def test_bundled_knowledge_all_agents_and_citations_in_both_modes(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'FAISS_INDEX_PATH': directory, 'GEMINI_API_KEY': ''}):
            for name in ['metadata.json', 'index.faiss']:
                shutil.copy2(ROOT / 'knowledge-base/embeddings/faiss_index' / name, Path(directory) / name)
            rag = service('rag-service')
            with TestClient(rag.app) as client:
                cases = [
                    ('india-loan', 'What is the minimum age?', r'(?i)age.*\d', 'loan'),
                    ('india-loan', 'What is the minimum age requirement for a loan?', r'(?i)age.*\d', 'loan'),
                    ('india-loan', 'What is the minimum age and salary to avail loan?', r'(?i)minimum monthly income', 'loan'),
                    ('india-loan', 'What documents are required for a personal loan?', r'(?i)PAN', 'loan'),
                    ('india-loan', 'What are the loan options available?', r'(?i)personal loan.*home loan', 'loan'),
                    ('india-insurance', 'What is the grace period?', r'(?i)\d.*days', 'insurance'),
                    ('ph-bancassurance', 'What is the grace period?', r'(?i)\d.*days', 'bancassurance'),
                    ('ph-bancassurance', 'What is the insurance grace period?', r'(?i)\d.*days', 'bancassurance'),
                    ('id-finance', 'Apa itu tenor?', r'(?i)jangka waktu', 'finance'),
                ]
                for mode in ['lexical', 'vector']:
                    rag.GEMINI_API_KEY = '' if mode == 'lexical' else 'fixture'
                    with patch.object(rag, 'embed_query_fast', return_value=np.ones((1, 3072), dtype=np.float32)):
                        for market, question, expected, product in cases:
                            with self.subTest(mode=mode, query=question):
                                result = client.post('/retrieve', json={'query': question, 'market': market}).json()
                                self.assertIsNone(result['abstention_reason'], result)
                                self.assertRegex(result['answer'], expected)
                                self.assertTrue(result['sources'])
                                self.assertTrue(all(s['product'] == product for s in result['sources']))
                                self.assertTrue(all(s['excerpt'] for s in result['sources']))
                                self.assertEqual(len(result['sources']), len(result['chunks']))
                rag.GEMINI_API_KEY = ''
                unsupported = client.post('/retrieve', json={'query': 'What is the weather?', 'market': 'india-loan'}).json()
                self.assertEqual(unsupported['sources'], [])
                self.assertIsNotNone(unsupported['abstention_reason'])
                wrong_market = client.post('/retrieve', json={
                    'query': 'minimum monthly income personal loan', 'market': 'philippines',
                }).json()
                self.assertEqual(wrong_market['sources'], [])
                self.assertIsNotNone(wrong_market['abstention_reason'])
                selected_product = client.post('/retrieve', json={
                    'query': 'minimum monthly income personal loan', 'market': 'india', 'product': 'personal-loan',
                }).json()
                self.assertIn('25,000', selected_product['answer'])
                self.assertTrue(selected_product['sources'])
                unsupported_fee = client.post('/retrieve', json={
                    'query': 'What is the personal loan document courier fee?', 'market': 'india',
                }).json()
                self.assertEqual(unsupported_fee['sources'], [])
                self.assertIsNotNone(unsupported_fee['abstention_reason'])
                stats = client.get('/stats').json()
                self.assertEqual(stats['total_chunks'], 84)
                self.assertTrue(all(n > 0 for n in stats['agent_scopes'].values()))

    def test_scope_filter_applies_before_vector_limit_and_metadata_updates_reload(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'FAISS_INDEX_PATH': directory, 'GEMINI_API_KEY': ''}):
            root = Path(directory)
            records = [{'source': f'ins-{i}', 'content': 'Insurance age: 99 years.', 'market': 'india', 'product': 'insurance'} for i in range(20)]
            records.append({'source': 'loan', 'content': 'Minimum age: 21 years.', 'market': 'india', 'product': 'loan'})
            index = faiss.IndexFlatIP(3072)
            vectors = np.zeros((21, 3072), dtype=np.float32)
            vectors[:20, 0] = 1
            vectors[20, 1] = 1
            index.add(vectors)
            faiss.write_index(index, str(root / 'index.faiss'))
            metadata = root / 'metadata.json'
            metadata.write_text(json.dumps(records))
            rag = service('rag-service')
            with TestClient(rag.app) as client, patch.object(rag, 'embed_query_fast', return_value=vectors[:1]), patch.object(rag, 'lexical_candidates', return_value=[]):
                rag.GEMINI_API_KEY = 'fixture'
                result = client.post('/retrieve', json={'query': 'minimum age', 'market': 'india-loan'}).json()
                self.assertEqual([s['source'] for s in result['sources']], ['loan'])
                records[-1]['agent_eligible'] = False
                metadata.write_text(json.dumps(records))
                result = client.post('/retrieve', json={'query': 'minimum age', 'market': 'india-loan'}).json()
                self.assertEqual(result['sources'], [])

    def test_legacy_ingestion_preserves_product_scope(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'FAISS_INDEX_PATH': directory, 'GEMINI_API_KEY': ''}):
            ingestion = service('ingestion-service')
            ingestion.GEMINI_API_KEY = 'fixture'
            with patch.object(ingestion.gemini, 'embed_content', return_value={'embedding': [[1.0] + [0.0] * 3071]}), TestClient(ingestion.app) as client:
                result = client.post('/ingest/text', json={'content': 'Minimum age is 21 years. ' * 8, 'filename': 'scoped.txt', 'market': 'india', 'product': 'loan', 'agent_eligible': False})
                self.assertEqual(result.status_code, 200, result.text)
                saved = json.loads((Path(directory) / 'metadata.json').read_text())
                self.assertEqual(saved[0]['product'], 'loan')
                self.assertFalse(saved[0]['agent_eligible'])


if __name__ == '__main__':
    unittest.main()
