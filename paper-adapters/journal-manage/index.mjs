import path from 'node:path';
import {
  ensureDir,
  normalizeText,
  nowIso,
  relativePath,
  uniqueStrings,
  writeJsonFile,
} from '../../paper-core/src/utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';
import {
  academicEvidenceReady,
  reviewAuthorityBlockers,
} from './review-authority.mjs';

export const JOURNAL_PROFILES = Object.freeze([
  {
    id: 'neurips',
    label: 'NeurIPS',
    kind: 'conference',
    aliases: ['neurips', 'nips'],
    keywords: ['machine learning', 'deep learning', 'reinforcement learning', 'optimization', 'neural', 'rl', 'artificial intelligence', 'ai'],
    requirements: [
      'clear ML novelty',
      'strong experiments or theory',
      'reproducibility checklist',
      'limitations statement',
    ],
    rubric: [
      'novelty_and_positioning',
      'technical_soundness',
      'evidence_or_theory_strength',
      'reproducibility',
      'limitations_and_claim_scope',
      'clarity',
    ],
  },
  {
    id: 'colt_alt',
    label: 'COLT/ALT',
    kind: 'conference',
    aliases: ['colt', 'alt', 'colt/alt', 'colt/alt candidate'],
    keywords: ['learning theory', 'online learning', 'reinforcement learning theory', 'regret', 'sample complexity'],
    requirements: [
      'formal problem statement',
      'theorem novelty',
      'complete proof strategy',
      'comparison to known bounds',
    ],
    rubric: [
      'formal_novelty',
      'proof_correctness',
      'assumption_minimality',
      'literature_positioning',
      'technical_clarity',
    ],
  },
  {
    id: 'focs',
    label: 'FOCS',
    kind: 'conference',
    aliases: ['focs', 'stoc/focs', 'focs candidate'],
    keywords: ['theory', 'algorithms', 'complexity', 'proof', 'lower bound', 'upper bound'],
    requirements: [
      'formal problem statement',
      'theorem novelty',
      'proof depth',
      'positioning against known bounds',
    ],
    rubric: [
      'theorem_significance',
      'proof_correctness',
      'technical_depth',
      'novelty_against_prior_work',
      'presentation_precision',
    ],
  },
  {
    id: 'operations_research',
    label: 'Operations Research',
    kind: 'journal',
    aliases: ['operations research', 'or'],
    keywords: ['operations research', 'stochastic control', 'optimization', 'policy', 'managerial'],
    requirements: [
      'model relevance',
      'theory or algorithmic contribution',
      'managerial insight',
      'computational evidence',
    ],
    rubric: [
      'problem_relevance',
      'technical_contribution',
      'evidence_quality',
      'managerial_or_practical_insight',
      'exposition',
    ],
  },
  {
    id: 'aos',
    label: 'Annals of Statistics',
    kind: 'journal',
    aliases: ['aos', 'annals of statistics'],
    keywords: ['statistics', 'asymptotic', 'estimator', 'inference', 'minimax'],
    requirements: [
      'mathematical rigor',
      'statistical contribution',
      'complete proof strategy',
      'assumption clarity',
    ],
    rubric: [
      'statistical_novelty',
      'proof_rigor',
      'assumption_clarity',
      'simulation_or_example_support',
      'writing_precision',
    ],
  },
  {
    id: 'nature',
    label: 'Nature',
    kind: 'journal',
    aliases: ['nature'],
    keywords: ['broad impact', 'interdisciplinary', 'scientific discovery'],
    requirements: [
      'broad framing',
      'high-level novelty',
      'clear story',
      'strong evidence package',
    ],
    rubric: [
      'broad_interest',
      'evidence_strength',
      'story_clarity',
      'novelty',
      'limitations',
    ],
  },
  {
    id: 'science',
    label: 'Science',
    kind: 'journal',
    aliases: ['science'],
    keywords: ['broad impact', 'interdisciplinary', 'scientific discovery', 'high impact'],
    requirements: ['broad scientific interest', 'strong evidence package', 'clear discovery story'],
    rubric: ['broad_interest', 'evidence_strength', 'novelty', 'story_clarity', 'limitations'],
  },
  {
    id: 'nature_machine_intelligence',
    label: 'Nature Machine Intelligence',
    kind: 'journal',
    aliases: ['nature machine intelligence', 'nmi'],
    keywords: ['machine learning', 'artificial intelligence', 'ai', 'robotics', 'responsible ai'],
    requirements: ['high-impact AI contribution', 'strong evidence', 'broad AI relevance'],
    rubric: ['ai_significance', 'technical_soundness', 'evidence_strength', 'broader_impact', 'clarity'],
  },
  {
    id: 'jmlr',
    label: 'JMLR',
    kind: 'journal',
    aliases: ['journal of machine learning research', 'jmlr'],
    keywords: ['machine learning', 'learning theory', 'reinforcement learning', 'statistical learning'],
    requirements: ['substantial ML contribution', 'complete technical development', 'reproducibility'],
    rubric: ['technical_depth', 'novelty', 'proof_or_experiment_quality', 'reproducibility', 'clarity'],
  },
  {
    id: 'tmlr',
    label: 'TMLR',
    kind: 'journal',
    aliases: ['transactions on machine learning research', 'tmlr'],
    keywords: ['machine learning', 'deep learning', 'reinforcement learning', 'representation learning'],
    requirements: ['sound ML contribution', 'complete evidence', 'transparent limitations'],
    rubric: ['technical_soundness', 'evidence_quality', 'claim_scope', 'reproducibility', 'clarity'],
  },
  {
    id: 'icml',
    label: 'ICML',
    kind: 'conference',
    aliases: ['icml'],
    keywords: ['machine learning', 'learning theory', 'reinforcement learning', 'optimization', 'probabilistic learning'],
    requirements: ['clear ML contribution', 'strong evidence or theory', 'comparison to prior work'],
    rubric: ['ml_novelty', 'technical_soundness', 'evidence_or_theory_strength', 'reproducibility', 'clarity'],
  },
  {
    id: 'iclr',
    label: 'ICLR',
    kind: 'conference',
    aliases: ['iclr'],
    keywords: ['representation learning', 'deep learning', 'foundation model', 'optimization', 'generative model'],
    requirements: ['representation learning relevance', 'strong experiments or analysis', 'clear limitations'],
    rubric: ['representation_novelty', 'technical_soundness', 'experimental_strength', 'limitations', 'clarity'],
  },
  {
    id: 'cvpr',
    label: 'CVPR',
    kind: 'conference',
    aliases: ['cvpr'],
    keywords: ['computer vision', 'vision', 'image', 'video', 'recognition', 'detection', 'segmentation'],
    requirements: ['vision contribution', 'strong empirical evaluation', 'comparison to baselines'],
    rubric: ['vision_novelty', 'experimental_strength', 'benchmarking', 'ablation_quality', 'clarity'],
  },
  {
    id: 'iccv',
    label: 'ICCV',
    kind: 'conference',
    aliases: ['iccv'],
    keywords: ['computer vision', 'vision', 'image', 'video', '3d vision', 'recognition'],
    requirements: ['vision contribution', 'strong empirical evaluation', 'clear novelty'],
    rubric: ['vision_novelty', 'technical_soundness', 'experimental_strength', 'ablation_quality', 'clarity'],
  },
  {
    id: 'eccv',
    label: 'ECCV',
    kind: 'conference',
    aliases: ['eccv'],
    keywords: ['computer vision', 'vision', 'image', 'video', 'visual learning'],
    requirements: ['vision contribution', 'benchmark evidence', 'clear method'],
    rubric: ['vision_novelty', 'benchmarking', 'technical_soundness', 'clarity', 'limitations'],
  },
  {
    id: 'tpami',
    label: 'IEEE TPAMI',
    kind: 'journal',
    aliases: ['tpami', 'ieee tpami', 'transactions on pattern analysis and machine intelligence'],
    keywords: ['computer vision', 'pattern recognition', 'machine intelligence', 'image', 'video'],
    requirements: ['substantial vision or pattern recognition contribution', 'complete evaluation', 'technical depth'],
    rubric: ['technical_depth', 'vision_or_pattern_significance', 'evaluation_quality', 'reproducibility', 'clarity'],
  },
  {
    id: 'tacl',
    label: 'TACL',
    kind: 'journal',
    aliases: ['tacl', 'transactions of the association for computational linguistics'],
    keywords: ['natural language processing', 'nlp', 'language model', 'computational linguistics', 'text'],
    requirements: ['substantial NLP contribution', 'sound evaluation', 'clear linguistic or modeling contribution'],
    rubric: ['nlp_significance', 'technical_soundness', 'evaluation_quality', 'ethics', 'clarity'],
  },
  {
    id: 'tois',
    label: 'ACM TOIS',
    kind: 'journal',
    aliases: ['tois', 'acm transactions on information systems'],
    keywords: ['information retrieval', 'web', 'database', 'recommendation', 'data mining'],
    requirements: ['information systems contribution', 'complete evaluation', 'clear retrieval or data relevance'],
    rubric: ['information_retrieval_significance', 'technical_soundness', 'evaluation_quality', 'scalability', 'clarity'],
  },
  {
    id: 'tocs',
    label: 'ACM TOCS',
    kind: 'journal',
    aliases: ['tocs', 'acm transactions on computer systems'],
    keywords: ['systems', 'distributed system', 'operating system', 'networked systems', 'storage'],
    requirements: ['substantial systems contribution', 'implementation evidence', 'complete evaluation'],
    rubric: ['systems_significance', 'implementation_quality', 'evaluation_strength', 'scalability', 'clarity'],
  },
  {
    id: 'tdsc',
    label: 'IEEE TDSC',
    kind: 'journal',
    aliases: ['tdsc', 'ieee transactions on dependable and secure computing'],
    keywords: ['security', 'privacy', 'dependable computing', 'vulnerability', 'systems security'],
    requirements: ['security or dependability contribution', 'threat model', 'sound evidence'],
    rubric: ['security_significance', 'threat_model_quality', 'technical_soundness', 'evidence_strength', 'clarity'],
  },
  {
    id: 'toplas',
    label: 'ACM TOPLAS',
    kind: 'journal',
    aliases: ['toplas', 'acm transactions on programming languages and systems'],
    keywords: ['programming language', 'compiler', 'type system', 'semantics', 'verification'],
    requirements: ['substantial programming languages contribution', 'proof or implementation evidence', 'semantic clarity'],
    rubric: ['pl_significance', 'proof_or_implementation_quality', 'semantic_clarity', 'technical_depth', 'clarity'],
  },
  {
    id: 'tse',
    label: 'IEEE TSE',
    kind: 'journal',
    aliases: ['tse', 'ieee transactions on software engineering'],
    keywords: ['software engineering', 'testing', 'program analysis', 'developer', 'software'],
    requirements: ['software engineering contribution', 'sound empirical or technical evaluation', 'practical relevance'],
    rubric: ['se_significance', 'evaluation_quality', 'technical_soundness', 'practical_impact', 'clarity'],
  },
  {
    id: 'tochi',
    label: 'ACM TOCHI',
    kind: 'journal',
    aliases: ['tochi', 'acm transactions on computer-human interaction'],
    keywords: ['human computer interaction', 'hci', 'user study', 'interaction', 'interface'],
    requirements: ['HCI contribution', 'study quality', 'clear design or interaction insight'],
    rubric: ['hci_contribution', 'study_quality', 'design_insight', 'ethics', 'clarity'],
  },
  {
    id: 'acl',
    label: 'ACL',
    kind: 'conference',
    aliases: ['acl'],
    keywords: ['natural language processing', 'nlp', 'language model', 'linguistics', 'text'],
    requirements: ['NLP contribution', 'sound evaluation', 'ethical considerations where relevant'],
    rubric: ['nlp_novelty', 'evaluation_quality', 'linguistic_or_modeling_soundness', 'ethics', 'clarity'],
  },
  {
    id: 'emnlp',
    label: 'EMNLP',
    kind: 'conference',
    aliases: ['emnlp'],
    keywords: ['natural language processing', 'nlp', 'language model', 'text', 'empirical nlp'],
    requirements: ['empirical NLP contribution', 'strong evaluation', 'baseline comparison'],
    rubric: ['nlp_novelty', 'empirical_strength', 'baseline_quality', 'reproducibility', 'clarity'],
  },
  {
    id: 'naacl',
    label: 'NAACL',
    kind: 'conference',
    aliases: ['naacl'],
    keywords: ['natural language processing', 'nlp', 'language model', 'text', 'computational linguistics'],
    requirements: ['NLP contribution', 'clear evaluation', 'ethical statement where relevant'],
    rubric: ['nlp_relevance', 'technical_soundness', 'evaluation_quality', 'ethics', 'clarity'],
  },
  {
    id: 'sigmod',
    label: 'SIGMOD',
    kind: 'conference',
    aliases: ['sigmod'],
    keywords: ['database', 'data management', 'query processing', 'transaction', 'storage'],
    requirements: ['data management contribution', 'systems or theoretical evaluation', 'scalability evidence'],
    rubric: ['database_significance', 'system_or_theory_soundness', 'performance_evidence', 'scalability', 'clarity'],
  },
  {
    id: 'vldb',
    label: 'VLDB',
    kind: 'conference',
    aliases: ['vldb', 'pvldb'],
    keywords: ['database', 'data management', 'query', 'analytics', 'storage'],
    requirements: ['database contribution', 'complete evaluation', 'clear systems relevance'],
    rubric: ['database_significance', 'evaluation_quality', 'scalability', 'system_relevance', 'clarity'],
  },
  {
    id: 'kdd',
    label: 'KDD',
    kind: 'conference',
    aliases: ['kdd'],
    keywords: ['data mining', 'knowledge discovery', 'graph mining', 'recommendation', 'applied machine learning'],
    requirements: ['data mining contribution', 'strong empirical evaluation', 'real-world relevance'],
    rubric: ['data_mining_novelty', 'empirical_strength', 'real_world_relevance', 'scalability', 'clarity'],
  },
  {
    id: 'www',
    label: 'The Web Conference',
    kind: 'conference',
    aliases: ['www', 'web conference', 'the web conference'],
    keywords: ['web', 'social network', 'information retrieval', 'recommendation', 'online platform'],
    requirements: ['web contribution', 'realistic evaluation', 'ethical considerations where relevant'],
    rubric: ['web_relevance', 'technical_soundness', 'evaluation_quality', 'ethics', 'clarity'],
  },
  {
    id: 'sigcomm',
    label: 'SIGCOMM',
    kind: 'conference',
    aliases: ['sigcomm'],
    keywords: ['networking', 'network', 'internet', 'protocol', 'congestion control'],
    requirements: ['networking contribution', 'system or measurement evidence', 'deployment relevance'],
    rubric: ['networking_significance', 'system_soundness', 'measurement_quality', 'deployment_relevance', 'clarity'],
  },
  {
    id: 'nsdi',
    label: 'NSDI',
    kind: 'conference',
    aliases: ['nsdi'],
    keywords: ['networked systems', 'distributed system', 'cloud', 'operating system', 'systems'],
    requirements: ['systems contribution', 'working prototype', 'strong evaluation'],
    rubric: ['systems_significance', 'implementation_quality', 'evaluation_strength', 'scalability', 'clarity'],
  },
  {
    id: 'sosp',
    label: 'SOSP',
    kind: 'conference',
    aliases: ['sosp'],
    keywords: ['operating system', 'distributed system', 'systems', 'storage', 'kernel'],
    requirements: ['systems novelty', 'real implementation', 'deep evaluation'],
    rubric: ['systems_novelty', 'implementation_depth', 'evaluation_strength', 'impact', 'clarity'],
  },
  {
    id: 'osdi',
    label: 'OSDI',
    kind: 'conference',
    aliases: ['osdi'],
    keywords: ['operating system', 'distributed system', 'systems', 'cloud', 'storage'],
    requirements: ['systems novelty', 'working system', 'strong evaluation'],
    rubric: ['systems_novelty', 'implementation_quality', 'evaluation_strength', 'scalability', 'clarity'],
  },
  {
    id: 'usenix_security',
    label: 'USENIX Security',
    kind: 'conference',
    aliases: ['usenix security', 'usenix sec'],
    keywords: ['security', 'privacy', 'attack', 'vulnerability', 'vulnerability detection', 'network protocol security', 'cryptographic system'],
    requirements: ['security contribution', 'threat model', 'responsible disclosure where relevant'],
    rubric: ['security_significance', 'threat_model_quality', 'evidence_strength', 'ethics', 'clarity'],
  },
  {
    id: 'ieee_sp',
    label: 'IEEE S&P',
    kind: 'conference',
    aliases: ['ieee s&p', 'oakland', 'ieee security and privacy'],
    keywords: ['security', 'privacy', 'vulnerability detection', 'systems security', 'network security', 'network protocol security', 'formal security'],
    requirements: ['security significance', 'clear threat model', 'sound evidence'],
    rubric: ['security_significance', 'technical_soundness', 'threat_model_quality', 'evidence_strength', 'clarity'],
  },
  {
    id: 'ccs',
    label: 'ACM CCS',
    kind: 'conference',
    aliases: ['ccs', 'acm ccs'],
    keywords: ['security', 'privacy', 'vulnerability detection', 'cryptography', 'systems security', 'network protocol security', 'web security'],
    requirements: ['security contribution', 'sound threat model', 'strong evidence'],
    rubric: ['security_novelty', 'threat_model_quality', 'technical_soundness', 'evidence_strength', 'clarity'],
  },
  {
    id: 'ndss',
    label: 'NDSS',
    kind: 'conference',
    aliases: ['ndss'],
    keywords: ['network security', 'network protocol security', 'vulnerability detection', 'systems security', 'privacy', 'internet security'],
    requirements: ['network or systems security contribution', 'threat model', 'evidence'],
    rubric: ['security_significance', 'threat_model_quality', 'evaluation_quality', 'ethics', 'clarity'],
  },
  {
    id: 'stoc',
    label: 'STOC',
    kind: 'conference',
    aliases: ['stoc', 'stoc/focs'],
    keywords: ['theory', 'algorithms', 'complexity', 'proof', 'lower bound', 'upper bound'],
    requirements: ['theorem significance', 'proof correctness', 'technical depth'],
    rubric: ['theorem_significance', 'proof_correctness', 'technical_depth', 'novelty_against_prior_work', 'clarity'],
  },
  {
    id: 'soda',
    label: 'SODA',
    kind: 'conference',
    aliases: ['soda'],
    keywords: ['algorithms', 'data structure', 'approximation algorithm', 'online algorithm', 'optimization'],
    requirements: ['algorithmic contribution', 'proof correctness', 'comparison to known bounds'],
    rubric: ['algorithmic_novelty', 'proof_correctness', 'bound_quality', 'technical_clarity', 'positioning'],
  },
  {
    id: 'jacm',
    label: 'JACM',
    kind: 'journal',
    aliases: ['jacm', 'journal of the acm'],
    keywords: ['theory', 'algorithms', 'complexity', 'programming languages', 'computing'],
    requirements: ['foundational computing contribution', 'complete proof', 'broad significance'],
    rubric: ['foundational_significance', 'technical_depth', 'proof_correctness', 'breadth', 'clarity'],
  },
  {
    id: 'sicomp',
    label: 'SIAM Journal on Computing',
    kind: 'journal',
    aliases: ['sicomp', 'siam journal on computing'],
    keywords: ['theory', 'algorithms', 'complexity', 'computing theory'],
    requirements: ['theoretical CS contribution', 'complete proof', 'positioning against prior work'],
    rubric: ['theory_significance', 'proof_correctness', 'technical_depth', 'positioning', 'clarity'],
  },
  {
    id: 'pldi',
    label: 'PLDI',
    kind: 'conference',
    aliases: ['pldi'],
    keywords: ['programming language', 'compiler', 'static analysis', 'runtime', 'verification'],
    requirements: ['programming languages contribution', 'sound method', 'evaluation or proof'],
    rubric: ['pl_significance', 'technical_soundness', 'evaluation_or_proof_quality', 'implementation', 'clarity'],
  },
  {
    id: 'popl',
    label: 'POPL',
    kind: 'conference',
    aliases: ['popl'],
    keywords: ['programming language', 'type system', 'formal methods', 'semantics', 'verification'],
    requirements: ['formal PL contribution', 'proof correctness', 'semantic clarity'],
    rubric: ['formal_novelty', 'proof_correctness', 'semantic_clarity', 'technical_depth', 'clarity'],
  },
  {
    id: 'icse',
    label: 'ICSE',
    kind: 'conference',
    aliases: ['icse'],
    keywords: ['software engineering', 'program analysis', 'testing', 'developer', 'software'],
    requirements: ['software engineering contribution', 'evaluation', 'practical relevance'],
    rubric: ['se_relevance', 'technical_soundness', 'evaluation_quality', 'practical_impact', 'clarity'],
  },
  {
    id: 'fse',
    label: 'FSE',
    kind: 'conference',
    aliases: ['fse', 'esec/fse'],
    keywords: ['software engineering', 'testing', 'program analysis', 'software maintenance'],
    requirements: ['software engineering contribution', 'sound evaluation', 'clear impact'],
    rubric: ['se_novelty', 'evaluation_quality', 'technical_soundness', 'impact', 'clarity'],
  },
  {
    id: 'chi',
    label: 'CHI',
    kind: 'conference',
    aliases: ['chi'],
    keywords: ['human computer interaction', 'hci', 'user study', 'interaction', 'interface'],
    requirements: ['HCI contribution', 'study design', 'human-subjects ethics where relevant'],
    rubric: ['hci_contribution', 'study_quality', 'design_insight', 'ethics', 'clarity'],
  },
  {
    id: 'uist',
    label: 'UIST',
    kind: 'conference',
    aliases: ['uist'],
    keywords: ['user interface', 'interaction technique', 'hci', 'interactive system'],
    requirements: ['interactive systems contribution', 'prototype', 'evaluation'],
    rubric: ['interaction_novelty', 'system_quality', 'evaluation_quality', 'design_insight', 'clarity'],
  },
  {
    id: 'siggraph',
    label: 'SIGGRAPH',
    kind: 'conference',
    aliases: ['siggraph'],
    keywords: ['graphics', 'rendering', 'animation', 'geometry', 'visual computing'],
    requirements: ['graphics contribution', 'visual or technical evidence', 'comparison to prior work'],
    rubric: ['graphics_novelty', 'technical_soundness', 'visual_evidence', 'comparison_quality', 'clarity'],
  },
  {
    id: 'toga',
    label: 'ACM TOG',
    kind: 'journal',
    aliases: ['tog', 'acm tog', 'transactions on graphics'],
    keywords: ['graphics', 'rendering', 'animation', 'geometry', 'visual computing'],
    requirements: ['substantial graphics contribution', 'complete evidence', 'technical clarity'],
    rubric: ['graphics_significance', 'technical_soundness', 'evidence_quality', 'visual_quality', 'clarity'],
  },
  {
    id: 'taco',
    label: 'ACM TACO',
    kind: 'journal',
    aliases: ['taco', 'acm transactions on architecture and code optimization'],
    keywords: ['computer architecture', 'microarchitecture', 'hardware', 'compiler optimization', 'memory system'],
    requirements: ['architecture or code optimization contribution', 'simulation or implementation evidence', 'clear baselines'],
    rubric: ['architecture_significance', 'evaluation_quality', 'performance_evidence', 'feasibility', 'clarity'],
  },
  {
    id: 'isca',
    label: 'ISCA',
    kind: 'conference',
    aliases: ['isca'],
    keywords: ['computer architecture', 'processor', 'memory system', 'hardware', 'microarchitecture'],
    requirements: ['architecture contribution', 'simulation or hardware evidence', 'baseline comparison'],
    rubric: ['architecture_novelty', 'evaluation_quality', 'performance_evidence', 'feasibility', 'clarity'],
  },
  {
    id: 'micro',
    label: 'MICRO',
    kind: 'conference',
    aliases: ['micro'],
    keywords: ['microarchitecture', 'processor', 'hardware', 'memory system', 'architecture'],
    requirements: ['microarchitecture contribution', 'evaluation', 'clear baselines'],
    rubric: ['architecture_novelty', 'performance_evidence', 'baseline_quality', 'feasibility', 'clarity'],
  },
  {
    id: 'asplos',
    label: 'ASPLOS',
    kind: 'conference',
    aliases: ['asplos'],
    keywords: ['architecture', 'programming languages', 'operating systems', 'systems', 'hardware software'],
    requirements: ['cross-layer systems contribution', 'implementation or simulation', 'strong evaluation'],
    rubric: ['cross_layer_novelty', 'system_quality', 'evaluation_strength', 'impact', 'clarity'],
  },
  {
    id: 'icra',
    label: 'ICRA',
    kind: 'conference',
    aliases: ['icra'],
    keywords: ['robotics', 'robot', 'control', 'manipulation', 'navigation', 'planning'],
    requirements: ['robotics contribution', 'simulation or hardware evidence', 'clear task setting'],
    rubric: ['robotics_novelty', 'experimental_strength', 'system_quality', 'task_relevance', 'clarity'],
  },
  {
    id: 'rss',
    label: 'RSS',
    kind: 'conference',
    aliases: ['rss', 'robotics science and systems'],
    keywords: ['robotics', 'robot learning', 'control', 'planning', 'manipulation'],
    requirements: ['robotics science contribution', 'strong evidence', 'clear novelty'],
    rubric: ['robotics_significance', 'technical_soundness', 'evidence_quality', 'system_or_theory_depth', 'clarity'],
  },
  {
    id: 'tro',
    label: 'IEEE Transactions on Robotics',
    kind: 'journal',
    aliases: ['tro', 'ieee transactions on robotics'],
    keywords: ['robotics', 'robot', 'control', 'manipulation', 'navigation', 'planning'],
    requirements: ['robotics contribution', 'simulation or hardware evidence', 'clear task setting'],
    rubric: ['robotics_significance', 'experimental_strength', 'system_quality', 'task_relevance', 'clarity'],
  },
  {
    id: 'ijrr',
    label: 'International Journal of Robotics Research',
    kind: 'journal',
    aliases: ['ijrr', 'international journal of robotics research'],
    keywords: ['robotics', 'robot learning', 'control', 'planning', 'manipulation'],
    requirements: ['robotics research contribution', 'strong evidence', 'clear novelty'],
    rubric: ['robotics_novelty', 'technical_soundness', 'evidence_quality', 'system_or_theory_depth', 'clarity'],
  },
  {
    id: 'automatica',
    label: 'Automatica',
    kind: 'journal',
    aliases: ['automatica'],
    keywords: ['control theory', 'control', 'dynamical system', 'stochastic control', 'adaptive control'],
    requirements: ['control contribution', 'mathematical rigor', 'system relevance'],
    rubric: ['control_novelty', 'proof_rigor', 'system_relevance', 'assumption_clarity', 'clarity'],
  },
  {
    id: 'ieee_tac',
    label: 'IEEE Transactions on Automatic Control',
    kind: 'journal',
    aliases: ['ieee tac', 'transactions on automatic control', 'tac'],
    keywords: ['control theory', 'control', 'dynamical system', 'stochastic control', 'optimization'],
    requirements: ['control theory contribution', 'proof rigor', 'clear assumptions'],
    rubric: ['control_significance', 'proof_rigor', 'assumption_clarity', 'technical_depth', 'clarity'],
  },
  {
    id: 'management_science',
    label: 'Management Science',
    kind: 'journal',
    aliases: ['management science', 'ms'],
    keywords: ['operations research', 'management', 'stochastic model', 'optimization', 'business analytics'],
    requirements: ['managerial relevance', 'technical contribution', 'evidence or analysis'],
    rubric: ['managerial_relevance', 'technical_contribution', 'evidence_quality', 'positioning', 'clarity'],
  },
  {
    id: 'aer',
    label: 'American Economic Review',
    kind: 'journal',
    aliases: ['aer', 'american economic review'],
    keywords: ['economics', 'applied economics', 'economic policy', 'empirical economics', 'macro economics', 'microeconomics'],
    requirements: ['first-order economics contribution', 'credible identification or model', 'clear welfare or policy relevance'],
    rubric: ['economic_significance', 'identification_or_model_quality', 'evidence_strength', 'policy_or_welfare_relevance', 'clarity'],
  },
  {
    id: 'qje',
    label: 'Quarterly Journal of Economics',
    kind: 'journal',
    aliases: ['qje', 'quarterly journal of economics'],
    keywords: ['economics', 'political economy', 'labor economics', 'development economics', 'public economics', 'economic mechanism'],
    requirements: ['major economics insight', 'compelling empirical or theoretical design', 'broad field relevance'],
    rubric: ['economic_importance', 'design_credibility', 'evidence_strength', 'mechanism_clarity', 'exposition'],
  },
  {
    id: 'jpe',
    label: 'Journal of Political Economy',
    kind: 'journal',
    aliases: ['jpe', 'journal of political economy'],
    keywords: ['economics', 'political economy', 'macro economics', 'microeconomic theory', 'market design', 'industrial organization'],
    requirements: ['deep economic mechanism', 'strong theory or identification', 'clear contribution to economics'],
    rubric: ['economic_mechanism', 'theory_or_identification_strength', 'novelty', 'evidence_quality', 'clarity'],
  },
  {
    id: 'econometrica',
    label: 'Econometrica',
    kind: 'journal',
    aliases: ['econometrica', 'ecta'],
    keywords: ['econometrics', 'economic theory', 'game theory', 'mechanism design', 'identification', 'estimation', 'equilibrium', 'asset pricing'],
    requirements: ['formal economics contribution', 'rigorous identification or proof', 'precise assumptions'],
    rubric: ['formal_economic_novelty', 'proof_or_identification_rigor', 'assumption_clarity', 'technical_depth', 'clarity'],
  },
  {
    id: 'restud',
    label: 'Review of Economic Studies',
    kind: 'journal',
    aliases: ['restud', 'review of economic studies'],
    keywords: ['economics', 'economic theory', 'applied economics', 'macro economics', 'microeconomics', 'market'],
    requirements: ['top-field economics contribution', 'rigorous evidence or theory', 'clear positioning'],
    rubric: ['economic_novelty', 'technical_rigor', 'evidence_quality', 'field_positioning', 'clarity'],
  },
  {
    id: 'journal_finance',
    label: 'Journal of Finance',
    kind: 'journal',
    aliases: ['journal of finance', 'jf'],
    keywords: ['finance', 'asset pricing', 'corporate finance', 'market microstructure', 'portfolio', 'risk premium'],
    requirements: ['first-order finance contribution', 'credible empirical or theoretical design', 'clear market relevance'],
    rubric: ['finance_significance', 'identification_or_model_quality', 'evidence_strength', 'market_relevance', 'clarity'],
  },
  {
    id: 'jfe',
    label: 'Journal of Financial Economics',
    kind: 'journal',
    aliases: ['jfe', 'journal of financial economics'],
    keywords: ['finance', 'asset pricing', 'corporate finance', 'capital markets', 'financial intermediation'],
    requirements: ['top finance contribution', 'credible design', 'strong evidence or model'],
    rubric: ['finance_novelty', 'design_credibility', 'evidence_quality', 'economic_mechanism', 'clarity'],
  },
  {
    id: 'rfs',
    label: 'Review of Financial Studies',
    kind: 'journal',
    aliases: ['rfs', 'review of financial studies'],
    keywords: ['finance', 'asset pricing', 'corporate finance', 'financial markets', 'banking', 'risk'],
    requirements: ['top finance contribution', 'technical or empirical strength', 'clear contribution to finance'],
    rubric: ['finance_contribution', 'technical_or_empirical_strength', 'mechanism_clarity', 'positioning', 'clarity'],
  },
  {
    id: 'accounting_review',
    label: 'The Accounting Review',
    kind: 'journal',
    aliases: ['accounting review', 'the accounting review', 'tar'],
    keywords: ['utd24', 'accounting', 'financial accounting', 'audit', 'disclosure', 'earnings'],
    requirements: ['accounting contribution', 'credible archival or theoretical design', 'clear accounting relevance'],
    rubric: ['accounting_significance', 'identification_or_model_quality', 'evidence_strength', 'institutional_relevance', 'clarity'],
  },
  {
    id: 'jae',
    label: 'Journal of Accounting and Economics',
    kind: 'journal',
    aliases: ['jae', 'journal of accounting and economics'],
    keywords: ['utd24', 'accounting', 'economics of accounting', 'disclosure', 'earnings', 'audit'],
    requirements: ['accounting economics contribution', 'credible design', 'clear mechanism'],
    rubric: ['accounting_economics_novelty', 'design_credibility', 'mechanism_clarity', 'evidence_quality', 'clarity'],
  },
  {
    id: 'jar',
    label: 'Journal of Accounting Research',
    kind: 'journal',
    aliases: ['jar', 'journal of accounting research'],
    keywords: ['utd24', 'accounting', 'accounting research', 'audit', 'disclosure', 'earnings'],
    requirements: ['accounting research contribution', 'methodological rigor', 'credible evidence'],
    rubric: ['accounting_contribution', 'methodological_rigor', 'evidence_quality', 'positioning', 'clarity'],
  },
  {
    id: 'isr',
    label: 'Information Systems Research',
    kind: 'journal',
    aliases: ['isr', 'information systems research'],
    keywords: ['utd24', 'information systems', 'digital platform', 'it economics', 'information technology'],
    requirements: ['information systems contribution', 'credible empirical or analytical design', 'managerial relevance'],
    rubric: ['is_significance', 'design_credibility', 'evidence_quality', 'managerial_relevance', 'clarity'],
  },
  {
    id: 'informs_joc',
    label: 'INFORMS Journal on Computing',
    kind: 'journal',
    aliases: ['informs journal on computing', 'ijoc', 'journal on computing'],
    keywords: ['utd24', 'computing', 'optimization', 'algorithms', 'analytics', 'operations research'],
    requirements: ['computing or analytics contribution', 'algorithmic rigor', 'computational evidence'],
    rubric: ['computing_significance', 'algorithmic_rigor', 'computational_evidence', 'scalability', 'clarity'],
  },
  {
    id: 'misq',
    label: 'MIS Quarterly',
    kind: 'journal',
    aliases: ['misq', 'mis quarterly', 'mis q'],
    keywords: ['utd24', 'information systems', 'management information systems', 'digital strategy', 'platform'],
    requirements: ['information systems contribution', 'strong theory or evidence', 'managerial relevance'],
    rubric: ['is_theory_contribution', 'evidence_quality', 'managerial_relevance', 'method_rigor', 'clarity'],
  },
  {
    id: 'jcr',
    label: 'Journal of Consumer Research',
    kind: 'journal',
    aliases: ['jcr', 'journal of consumer research'],
    keywords: ['utd24', 'marketing', 'consumer research', 'consumer behavior', 'psychology'],
    requirements: ['consumer behavior contribution', 'strong experimental or empirical design', 'theoretical insight'],
    rubric: ['consumer_insight', 'design_quality', 'theory_contribution', 'evidence_strength', 'clarity'],
  },
  {
    id: 'journal_marketing',
    label: 'Journal of Marketing',
    kind: 'journal',
    aliases: ['journal of marketing', 'jm'],
    keywords: ['utd24', 'marketing', 'marketing strategy', 'customer', 'brand', 'marketplace strategy'],
    requirements: ['marketing contribution', 'managerial relevance', 'credible evidence'],
    rubric: ['marketing_significance', 'managerial_relevance', 'evidence_quality', 'theory_or_strategy', 'clarity'],
  },
  {
    id: 'jmr',
    label: 'Journal of Marketing Research',
    kind: 'journal',
    aliases: ['jmr', 'journal of marketing research'],
    keywords: ['utd24', 'marketing', 'marketing research', 'consumer', 'causal', 'experiment'],
    requirements: ['marketing research contribution', 'methodological rigor', 'credible evidence'],
    rubric: ['marketing_research_novelty', 'method_rigor', 'evidence_quality', 'positioning', 'clarity'],
  },
  {
    id: 'marketing_science',
    label: 'Marketing Science',
    kind: 'journal',
    aliases: ['marketing science', 'mksc'],
    keywords: ['utd24', 'marketing', 'quantitative marketing', 'product pricing', 'consumer demand', 'advertising'],
    requirements: ['quantitative marketing contribution', 'model or identification rigor', 'managerial relevance'],
    rubric: ['quantitative_marketing_novelty', 'model_or_identification_rigor', 'evidence_quality', 'managerial_relevance', 'clarity'],
  },
  {
    id: 'msom',
    label: 'Manufacturing & Service Operations Management',
    kind: 'journal',
    aliases: ['msom', 'manufacturing and service operations management', 'manufacturing & service operations management'],
    keywords: ['utd24', 'operations management', 'manufacturing', 'service operations', 'supply chain'],
    requirements: ['operations management contribution', 'model or empirical rigor', 'managerial insight'],
    rubric: ['operations_management_significance', 'technical_or_empirical_rigor', 'managerial_insight', 'evidence_quality', 'clarity'],
  },
  {
    id: 'organization_science',
    label: 'Organization Science',
    kind: 'journal',
    aliases: ['organization science', 'org science'],
    keywords: ['utd24', 'management', 'organization', 'organizational theory', 'innovation', 'strategy'],
    requirements: ['organization theory contribution', 'credible evidence or model', 'clear organizational relevance'],
    rubric: ['organization_theory_contribution', 'design_or_model_quality', 'evidence_strength', 'relevance', 'clarity'],
  },
  {
    id: 'smj',
    label: 'Strategic Management Journal',
    kind: 'journal',
    aliases: ['smj', 'strategic management journal'],
    keywords: ['utd24', 'strategy', 'strategic management', 'firm performance', 'competitive advantage'],
    requirements: ['strategy contribution', 'credible design', 'managerial or strategic relevance'],
    rubric: ['strategy_significance', 'design_credibility', 'evidence_quality', 'managerial_relevance', 'clarity'],
  },
  {
    id: 'amj',
    label: 'Academy of Management Journal',
    kind: 'journal',
    aliases: ['amj', 'academy of management journal'],
    keywords: ['utd24', 'management', 'organization', 'strategy', 'organizational behavior'],
    requirements: ['management contribution', 'strong empirical design', 'clear theoretical contribution'],
    rubric: ['management_theory_contribution', 'empirical_design_quality', 'evidence_strength', 'relevance', 'clarity'],
  },
  {
    id: 'amr',
    label: 'Academy of Management Review',
    kind: 'journal',
    aliases: ['amr', 'academy of management review'],
    keywords: ['utd24', 'management theory', 'organization theory', 'strategy theory', 'theory development'],
    requirements: ['theoretical contribution', 'conceptual novelty', 'clear propositions'],
    rubric: ['theoretical_novelty', 'conceptual_rigor', 'proposition_quality', 'field_positioning', 'clarity'],
  },
  {
    id: 'asq',
    label: 'Administrative Science Quarterly',
    kind: 'journal',
    aliases: ['asq', 'administrative science quarterly'],
    keywords: ['utd24', 'organization', 'management', 'sociology of organizations', 'institutional theory'],
    requirements: ['organization science contribution', 'deep theory or evidence', 'field-level relevance'],
    rubric: ['organizational_significance', 'theory_or_evidence_depth', 'field_relevance', 'method_rigor', 'clarity'],
  },
  {
    id: 'jibs',
    label: 'Journal of International Business Studies',
    kind: 'journal',
    aliases: ['jibs', 'journal of international business studies'],
    keywords: ['utd24', 'international business', 'multinational', 'global strategy', 'cross-border'],
    requirements: ['international business contribution', 'credible cross-border design', 'global relevance'],
    rubric: ['international_business_significance', 'design_credibility', 'evidence_quality', 'global_relevance', 'clarity'],
  },
  {
    id: 'jom',
    label: 'Journal of Operations Management',
    kind: 'journal',
    aliases: ['jom', 'journal of operations management'],
    keywords: ['utd24', 'operations management', 'supply chain', 'process management', 'service operations'],
    requirements: ['operations management contribution', 'empirical or analytical rigor', 'managerial relevance'],
    rubric: ['operations_management_novelty', 'method_rigor', 'evidence_quality', 'managerial_relevance', 'clarity'],
  },
  {
    id: 'pom',
    label: 'Production and Operations Management',
    kind: 'journal',
    aliases: ['pom', 'production and operations management'],
    keywords: ['utd24', 'operations management', 'production', 'supply chain', 'service operations'],
    requirements: ['production or operations contribution', 'model or empirical rigor', 'managerial insight'],
    rubric: ['operations_contribution', 'technical_or_empirical_rigor', 'managerial_insight', 'evidence_quality', 'clarity'],
  },
  {
    id: 'moor',
    label: 'Mathematics of Operations Research',
    kind: 'journal',
    aliases: ['moor', 'mathematics of operations research'],
    keywords: ['operations research', 'optimization', 'stochastic model', 'queueing', 'decision process'],
    requirements: ['mathematical OR contribution', 'proof rigor', 'clear model relevance'],
    rubric: ['or_theory_significance', 'proof_rigor', 'model_relevance', 'technical_depth', 'clarity'],
  },
  {
    id: 'siam_optimization',
    label: 'SIAM Journal on Optimization',
    kind: 'journal',
    aliases: ['siam journal on optimization', 'siopt'],
    keywords: ['optimization', 'convex optimization', 'nonconvex optimization', 'algorithm', 'convergence'],
    requirements: ['optimization contribution', 'proof rigor', 'algorithmic significance'],
    rubric: ['optimization_novelty', 'proof_rigor', 'algorithmic_significance', 'comparison_quality', 'clarity'],
  },
  {
    id: 'jasa',
    label: 'JASA',
    kind: 'journal',
    aliases: ['jasa', 'journal of the american statistical association'],
    keywords: ['statistics', 'inference', 'regression', 'causal', 'bayesian', 'estimator'],
    requirements: ['statistical contribution', 'methodological evidence', 'clear assumptions'],
    rubric: ['statistical_novelty', 'methodological_soundness', 'evidence_quality', 'assumption_clarity', 'clarity'],
  },
  {
    id: 'jrssb',
    label: 'JRSSB',
    kind: 'journal',
    aliases: ['jrssb', 'journal of the royal statistical society series b'],
    keywords: ['statistics', 'statistical methodology', 'inference', 'bayesian', 'asymptotic'],
    requirements: ['statistical methodology contribution', 'theory', 'examples or simulations'],
    rubric: ['methodological_novelty', 'proof_rigor', 'example_quality', 'assumption_clarity', 'clarity'],
  },
  {
    id: 'biometrika',
    label: 'Biometrika',
    kind: 'journal',
    aliases: ['biometrika'],
    keywords: ['statistics', 'biostatistics', 'inference', 'asymptotic', 'methodology'],
    requirements: ['statistical contribution', 'mathematical rigor', 'illustrative evidence'],
    rubric: ['statistical_novelty', 'proof_rigor', 'evidence_quality', 'assumption_clarity', 'clarity'],
  },
  {
    id: 'annals_math',
    label: 'Annals of Mathematics',
    kind: 'journal',
    aliases: ['annals of mathematics', 'annals math', 'annals'],
    keywords: ['mathematics', 'pure mathematics', 'geometry', 'analysis', 'number theory', 'topology', 'proof'],
    requirements: ['major mathematical theorem', 'complete proof', 'deep novelty'],
    rubric: ['mathematical_significance', 'proof_correctness', 'technical_depth', 'novelty', 'exposition'],
  },
  {
    id: 'inventiones',
    label: 'Inventiones Mathematicae',
    kind: 'journal',
    aliases: ['inventiones', 'inventiones mathematicae'],
    keywords: ['mathematics', 'pure mathematics', 'geometry', 'analysis', 'algebra', 'number theory', 'topology'],
    requirements: ['major mathematical contribution', 'proof rigor', 'clear relation to prior work'],
    rubric: ['mathematical_novelty', 'proof_rigor', 'technical_depth', 'field_positioning', 'clarity'],
  },
  {
    id: 'acta_math',
    label: 'Acta Mathematica',
    kind: 'journal',
    aliases: ['acta mathematica', 'acta math'],
    keywords: ['mathematics', 'pure mathematics', 'analysis', 'geometry', 'number theory', 'topology'],
    requirements: ['deep mathematical contribution', 'complete proof', 'broad mathematical significance'],
    rubric: ['mathematical_depth', 'proof_correctness', 'broad_significance', 'novel_technique', 'exposition'],
  },
  {
    id: 'jams',
    label: 'Journal of the American Mathematical Society',
    kind: 'journal',
    aliases: ['jams', 'journal of the american mathematical society'],
    keywords: ['mathematics', 'pure mathematics', 'geometry', 'analysis', 'number theory', 'topology', 'algebra'],
    requirements: ['major mathematical result', 'complete rigorous proof', 'high field impact'],
    rubric: ['mathematical_impact', 'proof_rigor', 'technical_depth', 'novelty', 'clarity'],
  },
]);

const PROFILE_POLICY_DEFAULTS = Object.freeze({
  neurips: {
    disciplineTags: ['machine_learning', 'artificial_intelligence', 'reinforcement_learning', 'optimization'],
    template: 'neurips',
    pageLimit: 'main_text_9_pages_plus_references',
    anonymity: 'double_blind',
    deadlinePolicy: 'annual_conference_deadline_required_before_live_submission',
    reviewStyle: 'novelty_soundness_reproducibility_limitations',
    evidenceRequirements: ['theory_or_experiment', 'reproducibility_artifacts', 'limitations_statement'],
    deskRejectRules: ['missing_reproducibility_checklist', 'unsupported_empirical_claims', 'unclear_ml_contribution'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  colt_alt: {
    disciplineTags: ['learning_theory', 'reinforcement_learning_theory'],
    template: 'colt_alt',
    pageLimit: 'conference_theory_format',
    anonymity: 'venue_specific',
    deadlinePolicy: 'annual_conference_deadline_required_before_live_submission',
    reviewStyle: 'theorem_novelty_proof_correctness_assumption_minimality',
    evidenceRequirements: ['formal_theorem_statement', 'complete_proof_strategy', 'prior_bound_comparison'],
    deskRejectRules: ['missing_main_theorem', 'proof_gap_in_core_claim', 'weak_positioning_against_known_bounds'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  focs: {
    disciplineTags: ['theoretical_computer_science', 'algorithms', 'proofs'],
    template: 'focs',
    pageLimit: 'conference_theory_format',
    anonymity: 'venue_specific',
    deadlinePolicy: 'annual_conference_deadline_required_before_live_submission',
    reviewStyle: 'technical_depth_proof_correctness_significance',
    evidenceRequirements: ['formal_problem_statement', 'main_theorem', 'proof_architecture'],
    deskRejectRules: ['insufficient_theorem_significance', 'proof_gap_in_core_claim', 'unclear_relation_to_known_bounds'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  operations_research: {
    disciplineTags: ['operations_research', 'stochastic_control', 'optimization'],
    template: 'operations_research_journal',
    pageLimit: 'journal_manuscript_with_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_or_special_issue_policy_required_before_live_submission',
    reviewStyle: 'problem_relevance_technical_contribution_evidence_managerial_insight',
    evidenceRequirements: ['model_relevance', 'technical_result', 'computational_or_theoretical_evidence', 'managerial_insight'],
    deskRejectRules: ['unclear_problem_relevance', 'missing_managerial_or_practical_insight', 'unsupported_computational_claims'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  aer: {
    disciplineTags: ['economics', 'applied_economics', 'policy_economics'],
    template: 'top_economics_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'economic_significance_identification_evidence_policy_relevance',
    evidenceRequirements: ['economics_contribution', 'credible_identification_or_model', 'robustness_or_proof_support', 'clear_welfare_or_policy_implication'],
    deskRejectRules: ['incremental_economics_question', 'weak_identification_or_model', 'unsupported_policy_claims'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  qje: {
    disciplineTags: ['economics', 'political_economy', 'labor_economics', 'development_economics', 'public_economics'],
    template: 'top_economics_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'major_economic_insight_design_credibility_mechanism_clarity',
    evidenceRequirements: ['major_economics_insight', 'credible_empirical_or_theoretical_design', 'mechanism_evidence', 'broad_field_relevance'],
    deskRejectRules: ['narrow_incremental_claim', 'mechanism_not_supported', 'field_relevance_unclear'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  jpe: {
    disciplineTags: ['economics', 'political_economy', 'market_design', 'industrial_organization', 'economic_theory'],
    template: 'top_economics_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'economic_mechanism_theory_identification_depth',
    evidenceRequirements: ['economic_mechanism', 'strong_theory_or_identification', 'literature_positioning', 'implication_analysis'],
    deskRejectRules: ['mechanism_not_sharp', 'weak_theory_or_identification', 'unclear_economics_contribution'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  econometrica: {
    disciplineTags: ['econometrics', 'economic_theory', 'game_theory', 'mechanism_design', 'identification'],
    template: 'econometrica_journal',
    pageLimit: 'journal_manuscript_with_formal_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'formal_economic_novelty_identification_proof_rigor',
    evidenceRequirements: ['formal_model_or_identification_strategy', 'complete_proof_or_estimation_argument', 'assumption_clarity', 'economic_interpretation'],
    deskRejectRules: ['missing_formal_contribution', 'proof_or_identification_gap', 'assumptions_unclear'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  restud: {
    disciplineTags: ['economics', 'economic_theory', 'applied_economics', 'macroeconomics', 'microeconomics'],
    template: 'top_economics_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'economic_novelty_rigor_positioning',
    evidenceRequirements: ['top_field_economics_contribution', 'rigorous_evidence_or_theory', 'clear_positioning', 'limitations_or_scope'],
    deskRejectRules: ['incremental_positioning', 'evidence_or_theory_insufficient', 'scope_overclaim'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  journal_finance: {
    disciplineTags: ['finance', 'asset_pricing', 'corporate_finance', 'market_microstructure'],
    template: 'top_finance_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'finance_significance_design_evidence_market_relevance',
    evidenceRequirements: ['first_order_finance_question', 'credible_empirical_or_theoretical_design', 'robustness_or_model_support', 'market_relevance'],
    deskRejectRules: ['incremental_finance_question', 'weak_identification_or_model', 'market_relevance_unclear'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  jfe: {
    disciplineTags: ['finance', 'asset_pricing', 'corporate_finance', 'capital_markets', 'financial_intermediation'],
    template: 'top_finance_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'finance_novelty_design_credibility_economic_mechanism',
    evidenceRequirements: ['top_finance_contribution', 'credible_design', 'strong_evidence_or_model', 'finance_mechanism'],
    deskRejectRules: ['weak_finance_mechanism', 'evidence_not_decisive', 'unclear_contribution_to_finance'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  rfs: {
    disciplineTags: ['finance', 'asset_pricing', 'corporate_finance', 'banking', 'financial_markets'],
    template: 'top_finance_journal',
    pageLimit: 'journal_manuscript_with_online_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'finance_contribution_technical_strength_positioning',
    evidenceRequirements: ['top_finance_contribution', 'technical_or_empirical_strength', 'mechanism_clarity', 'robustness_support'],
    deskRejectRules: ['incremental_finance_positioning', 'technical_or_empirical_gap', 'mechanism_unclear'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  aos: {
    disciplineTags: ['statistics', 'mathematical_statistics'],
    template: 'statistics_journal',
    pageLimit: 'journal_manuscript_with_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'statistical_novelty_rigor_assumption_clarity',
    evidenceRequirements: ['statistical_theorem', 'proof_rigor', 'assumption_clarity', 'simulation_or_example_support'],
    deskRejectRules: ['missing_statistical_contribution', 'proof_gap_in_core_claim', 'unclear_assumptions'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  annals_math: {
    disciplineTags: ['mathematics', 'pure_mathematics', 'geometry', 'analysis', 'number_theory', 'topology'],
    template: 'top_mathematics_journal',
    pageLimit: 'journal_manuscript_with_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'major_theorem_proof_rigor_field_significance',
    evidenceRequirements: ['major_theorem_statement', 'complete_proof', 'field_significance', 'prior_work_positioning'],
    deskRejectRules: ['insufficient_mathematical_significance', 'proof_gap_in_core_theorem', 'unclear_prior_work_relation'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  inventiones: {
    disciplineTags: ['mathematics', 'pure_mathematics', 'geometry', 'analysis', 'algebra', 'number_theory'],
    template: 'top_mathematics_journal',
    pageLimit: 'journal_manuscript_with_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'mathematical_depth_proof_rigor_novel_technique',
    evidenceRequirements: ['major_mathematical_contribution', 'complete_proof', 'novel_technique', 'field_positioning'],
    deskRejectRules: ['incremental_mathematical_result', 'proof_gap_in_core_theorem', 'novelty_unclear'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  acta_math: {
    disciplineTags: ['mathematics', 'pure_mathematics', 'analysis', 'geometry', 'number_theory', 'topology'],
    template: 'top_mathematics_journal',
    pageLimit: 'journal_manuscript_with_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'deep_mathematical_result_complete_proof_broad_significance',
    evidenceRequirements: ['deep_mathematical_result', 'complete_proof', 'broad_mathematical_significance', 'clear_exposition'],
    deskRejectRules: ['insufficient_depth', 'proof_gap_in_core_theorem', 'scope_too_narrow_for_top_math'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  jams: {
    disciplineTags: ['mathematics', 'pure_mathematics', 'geometry', 'analysis', 'number_theory', 'topology', 'algebra'],
    template: 'top_mathematics_journal',
    pageLimit: 'journal_manuscript_with_appendix',
    anonymity: 'journal_specific',
    deadlinePolicy: 'rolling_policy_required_before_live_submission',
    reviewStyle: 'major_result_proof_rigor_high_field_impact',
    evidenceRequirements: ['major_result', 'complete_rigorous_proof', 'high_field_impact', 'precise_positioning'],
    deskRejectRules: ['field_impact_unclear', 'proof_gap_in_core_theorem', 'insufficient_novelty'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
  nature: {
    disciplineTags: ['broad_science', 'interdisciplinary'],
    template: 'nature_article',
    pageLimit: 'journal_article_strict_story_format',
    anonymity: 'journal_specific',
    deadlinePolicy: 'editorial_scope_check_required_before_live_submission',
    reviewStyle: 'broad_interest_story_evidence_novelty',
    evidenceRequirements: ['broad_impact_framing', 'strong_evidence_package', 'limitations_statement'],
    deskRejectRules: ['too_narrow_for_broad_audience', 'weak_evidence_package', 'unclear_story'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  },
});

const DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS = 120;

const COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING = Object.freeze({
  neurips: {
    deadlineCalendar: [{ month: 5, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['jmlr', 'tmlr', 'nature_machine_intelligence'],
  },
  icml: {
    deadlineCalendar: [{ month: 1, day: 30, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['jmlr', 'tmlr'],
  },
  iclr: {
    deadlineCalendar: [{ month: 9, day: 25, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['jmlr', 'tmlr'],
  },
  cvpr: {
    deadlineCalendar: [{ month: 11, day: 14, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tpami'],
  },
  iccv: {
    deadlineCalendar: [{ month: 3, day: 8, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tpami'],
  },
  eccv: {
    deadlineCalendar: [{ month: 3, day: 6, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tpami'],
  },
  acl: {
    deadlineCalendar: [{ month: 2, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tacl', 'jmlr'],
  },
  emnlp: {
    deadlineCalendar: [{ month: 5, day: 20, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tacl', 'jmlr'],
  },
  naacl: {
    deadlineCalendar: [{ month: 10, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tacl', 'jmlr'],
  },
  sigmod: {
    deadlineCalendar: [{ month: 6, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['informs_joc', 'tois'],
  },
  vldb: {
    deadlineCadence: 'monthly',
    recurringDayOfMonth: 1,
    longHorizonThresholdDays: 45,
    journalFallbackIds: ['informs_joc', 'tois'],
  },
  kdd: {
    deadlineCalendar: [{ month: 2, day: 10, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tois', 'jmlr'],
  },
  www: {
    deadlineCalendar: [{ month: 10, day: 10, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tois'],
  },
  sigcomm: {
    deadlineCalendar: [{ month: 1, day: 30, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tocs'],
  },
  nsdi: {
    deadlineCalendar: [{ month: 9, day: 12, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tocs'],
  },
  sosp: {
    deadlineCalendar: [{ month: 4, day: 20, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tocs'],
  },
  osdi: {
    deadlineCalendar: [{ month: 12, day: 8, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tocs'],
  },
  usenix_security: {
    deadlineCalendar: [
      { month: 2, day: 1, label: 'estimated spring cycle deadline' },
      { month: 6, day: 1, label: 'estimated summer cycle deadline' },
      { month: 10, day: 1, label: 'estimated fall cycle deadline' },
    ],
    journalFallbackIds: ['tdsc', 'jacm'],
  },
  ieee_sp: {
    deadlineCalendar: [
      { month: 3, day: 1, label: 'estimated spring cycle deadline' },
      { month: 6, day: 1, label: 'estimated summer cycle deadline' },
      { month: 10, day: 1, label: 'estimated fall cycle deadline' },
    ],
    journalFallbackIds: ['tdsc', 'jacm'],
  },
  ccs: {
    deadlineCalendar: [{ month: 1, day: 20, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tdsc', 'jacm'],
  },
  ndss: {
    deadlineCalendar: [{ month: 5, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tdsc', 'jacm'],
  },
  focs: {
    deadlineCalendar: [{ month: 4, day: 5, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['jacm', 'sicomp'],
  },
  stoc: {
    deadlineCalendar: [{ month: 11, day: 1, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['jacm', 'sicomp'],
  },
  soda: {
    deadlineCalendar: [{ month: 7, day: 8, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['sicomp', 'jacm'],
  },
  colt_alt: {
    deadlineCalendar: [{ month: 1, day: 30, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['jmlr', 'sicomp'],
  },
  pldi: {
    deadlineCalendar: [{ month: 11, day: 16, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['toplas', 'jacm'],
  },
  popl: {
    deadlineCalendar: [{ month: 7, day: 10, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['toplas', 'jacm'],
  },
  icse: {
    deadlineCalendar: [{ month: 8, day: 25, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tse'],
  },
  fse: {
    deadlineCalendar: [{ month: 9, day: 12, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tse'],
  },
  chi: {
    deadlineCalendar: [{ month: 9, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tochi'],
  },
  uist: {
    deadlineCalendar: [{ month: 4, day: 10, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tochi'],
  },
  siggraph: {
    deadlineCalendar: [{ month: 1, day: 24, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['toga'],
  },
  isca: {
    deadlineCalendar: [{ month: 11, day: 18, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['taco', 'jacm'],
  },
  micro: {
    deadlineCalendar: [{ month: 4, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['taco', 'jacm'],
  },
  asplos: {
    deadlineCalendar: [{ month: 8, day: 10, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['taco', 'tocs'],
  },
  icra: {
    deadlineCalendar: [{ month: 9, day: 15, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tro', 'ijrr'],
  },
  rss: {
    deadlineCalendar: [{ month: 1, day: 20, label: 'estimated annual main paper deadline' }],
    journalFallbackIds: ['tro', 'ijrr'],
  },
});

function tokenText(values = []) {
  return values.map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join(' ');
}

function profileScore(profile, text, tokens) {
  const values = [
    profile.id,
    profile.label,
    ...(profile.aliases || []),
    ...(profile.keywords || []),
  ];
  return values.reduce((sum, value) => {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return sum;
    if (/^[a-z0-9]+$/.test(normalized)) return sum + (tokens.has(normalized) ? 2 : 0);
    return sum + (text.includes(normalized) ? 2 : 0);
  }, 0);
}

export function resolveJournalProfile({ target = null, hints = [], fallbackId = 'neurips' } = {}) {
  const text = tokenText([target, ...hints]);
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = JOURNAL_PROFILES.map((profile) => ({
    profile,
    score: profileScore(profile, text, tokens),
  })).sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id));
  return scored.find((item) => item.score > 0)?.profile
    || JOURNAL_PROFILES.find((profile) => profile.id === fallbackId)
    || JOURNAL_PROFILES[0];
}

function defaultJournalFallbackIds(profile = {}) {
  if (profile.kind !== 'conference') return [];
  const profileText = tokenText([
    profile.id,
    profile.label,
    ...(profile.keywords || []),
  ]);
  const profileTokens = new Set(profileText.split(/[^a-z0-9]+/).filter(Boolean));
  const journalScores = JOURNAL_PROFILES
    .filter((candidate) => candidate.kind === 'journal')
    .map((candidate, index) => ({
      id: candidate.id,
      score: profileScore(candidate, profileText, profileTokens),
      order: index,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, 3)
    .map((item) => item.id);
  return uniqueStrings([...journalScores, 'jmlr', 'jacm'], 5);
}

function withConferenceDeadlineRouting(profile = {}, policy = {}) {
  if (profile.kind !== 'conference') return policy;
  const deadlineRouting = COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING[profile.id] || {};
  return {
    ...policy,
    deadlinePolicy: policy.deadlinePolicy || 'conference_deadline_required_before_live_submission',
    deadlineRouting: {
      kind: 'ComputerScienceConferenceDeadlineRoutingPolicy',
      computerScienceConference: true,
      agentJudged: true,
      routeWhenDeadlineTooFar: true,
      longHorizonThresholdDays: Number(deadlineRouting.longHorizonThresholdDays)
        || DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS,
      deadlineCadence: deadlineRouting.deadlineCadence || 'annual',
      recurringDayOfMonth: deadlineRouting.recurringDayOfMonth || null,
      deadlineCalendar: deadlineRouting.deadlineCalendar || [],
      journalFallbackIds: uniqueStrings(
        deadlineRouting.journalFallbackIds || defaultJournalFallbackIds(profile),
        8,
      ),
      explicitTargetDoesNotAutoRetarget: true,
      judgementBasis: [
        'profile_deadline_calendar',
        'days_until_next_deadline',
        'same_field_journal_fallback_fit',
        'operator_target_lock',
      ],
    },
  };
}

function profilePolicy(profile = {}) {
  const policy = PROFILE_POLICY_DEFAULTS[profile.id] || {
    disciplineTags: profile.keywords || [],
    template: `${profile.id || 'journal'}_template`,
    pageLimit: profile.kind === 'journal' ? 'journal_manuscript_with_appendix' : 'conference_format',
    anonymity: 'venue_specific',
    deadlinePolicy: 'venue_policy_required_before_live_submission',
    reviewStyle: 'venue_specific_referee_review',
    evidenceRequirements: ['real_research_evidence', 'clear_claim_scope', 'reproducibility_or_proof_support'],
    deskRejectRules: ['target_scope_mismatch', 'unsupported_core_claim'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  };
  return withConferenceDeadlineRouting(profile, policy);
}

function enrichProfile(profile = {}) {
  const policy = profilePolicy(profile);
  return {
    ...profile,
    policy,
    requirements: uniqueStrings([...(profile.requirements || []), ...(policy.evidenceRequirements || [])], 32),
  };
}

function normalizeAsOfDate(value = null) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

function deadlineDate(year, entry = {}) {
  const month = Number(entry.month);
  const day = Number(entry.day);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
}

function nextMonthlyDeadline({ asOf, recurringDayOfMonth = 1 } = {}) {
  const day = Math.max(1, Math.min(28, Number(recurringDayOfMonth) || 1));
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();
  for (let offset = 0; offset <= 18; offset += 1) {
    const candidate = new Date(Date.UTC(year, month + offset, day, 23, 59, 59));
    if (candidate.getTime() >= asOf.getTime()) {
      return {
        date: candidate,
        label: `estimated monthly deadline day ${day}`,
      };
    }
  }
  return null;
}

function nextAnnualDeadline({ asOf, calendar = [] } = {}) {
  const year = asOf.getUTCFullYear();
  const candidates = [];
  for (let yearOffset = 0; yearOffset <= 2; yearOffset += 1) {
    for (const entry of calendar || []) {
      const candidate = deadlineDate(year + yearOffset, entry);
      if (candidate && candidate.getTime() >= asOf.getTime()) {
        candidates.push({
          date: candidate,
          label: entry.label || 'estimated annual deadline',
        });
      }
    }
  }
  return candidates.sort((left, right) => left.date.getTime() - right.date.getTime())[0] || null;
}

function daysUntilDeadline(asOf, deadline) {
  if (!deadline) return null;
  const milliseconds = deadline.getTime() - asOf.getTime();
  return Math.max(0, Math.ceil(milliseconds / (24 * 60 * 60 * 1000)));
}

function deadlineAssessmentForProfile({ profile = {}, createdAt = null } = {}) {
  const deadlineRouting = profile.policy?.deadlineRouting || null;
  if (!deadlineRouting?.computerScienceConference) {
    return {
      status: 'deadline_routing_not_applicable',
      evaluated: false,
    };
  }
  const asOf = normalizeAsOfDate(createdAt);
  const nextDeadline = deadlineRouting.deadlineCadence === 'monthly'
    ? nextMonthlyDeadline({
      asOf,
      recurringDayOfMonth: deadlineRouting.recurringDayOfMonth,
    })
    : nextAnnualDeadline({
      asOf,
      calendar: deadlineRouting.deadlineCalendar,
    });
  const daysToDeadline = daysUntilDeadline(asOf, nextDeadline?.date || null);
  const thresholdDays = Number(deadlineRouting.longHorizonThresholdDays)
    || DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS;
  const tooFar = Number.isFinite(daysToDeadline) && daysToDeadline > thresholdDays;
  return {
    status: tooFar
      ? 'conference_deadline_too_far'
      : 'conference_deadline_within_agent_window',
    evaluated: true,
    evaluatedAt: asOf.toISOString(),
    thresholdDays,
    daysToDeadline,
    nextDeadline: nextDeadline
      ? {
        date: nextDeadline.date.toISOString().slice(0, 10),
        label: nextDeadline.label,
      }
      : null,
    deadlineCadence: deadlineRouting.deadlineCadence,
    routeWhenDeadlineTooFar: deadlineRouting.routeWhenDeadlineTooFar === true,
    journalFallbackIds: deadlineRouting.journalFallbackIds || [],
  };
}

function rankedItemForProfile(profile, ranked = []) {
  const rankedItem = ranked.find((item) => item.profile.id === profile.id);
  if (rankedItem) return rankedItem;
  return {
    profile,
    score: 0,
    fitScore: 45,
    order: Number.MAX_SAFE_INTEGER,
  };
}

function chooseJournalFallback({ conferenceItem = null, ranked = [], registry = null } = {}) {
  const profiles = registry?.profiles || JOURNAL_PROFILES.map((profile) => enrichProfile(profile));
  const fallbackIds = conferenceItem?.profile?.policy?.deadlineRouting?.journalFallbackIds || [];
  const fallbackItems = fallbackIds
    .map((journalId, index) => {
      const profile = profiles.find((candidate) => candidate.id === journalId && candidate.kind === 'journal');
      if (!profile) return null;
      const rankedItem = rankedItemForProfile(profile, ranked);
      return {
        ...rankedItem,
        fallbackOrder: index,
        agentFallbackScore: rankedItem.score * 2 + (fallbackIds.length - index),
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.agentFallbackScore - left.agentFallbackScore
      || right.fitScore - left.fitScore
      || left.fallbackOrder - right.fallbackOrder
    ));
  return fallbackItems[0]
    || ranked.find((item) => item.profile.kind === 'journal' && item.score > 0)
    || null;
}

function buildAgentDeadlineRoutingDecision({
  primaryItem = null,
  ranked = [],
  registry = null,
  resolvedTarget = '',
  createdAt = null,
} = {}) {
  const initialProfile = primaryItem?.profile || null;
  const initialAssessment = deadlineAssessmentForProfile({ profile: initialProfile, createdAt });
  const explicitTarget = Boolean(resolvedTarget);
  if (!initialProfile || initialProfile.kind !== 'conference' || !initialAssessment.evaluated) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'deadline_routing_not_applicable',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: initialProfile
        ? { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind }
        : null,
      deadlineAssessment: initialAssessment,
      rationale: ['primary target is not a CS conference with deadline-routing metadata'],
    };
  }
  if (explicitTarget) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'explicit_target_preserved_deadline_risk_recorded',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      selectedTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      deadlineAssessment: initialAssessment,
      rationale: [
        'operator requested a target venue, so agent records deadline risk without retargeting',
      ],
    };
  }
  const shouldRouteToJournal = initialAssessment.status === 'conference_deadline_too_far'
    && initialAssessment.routeWhenDeadlineTooFar;
  if (!shouldRouteToJournal) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'conference_deadline_within_agent_window',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      selectedTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      deadlineAssessment: initialAssessment,
      rationale: ['conference deadline is close enough to keep the conference route'],
    };
  }
  const fallbackItem = chooseJournalFallback({ conferenceItem: primaryItem, ranked, registry });
  if (!fallbackItem) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'conference_deadline_too_far_no_journal_fallback',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      selectedTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      deadlineAssessment: initialAssessment,
      rationale: ['conference deadline is too far but no same-field journal fallback was available'],
    };
  }
  return {
    kind: 'AgentDeadlineRoutingDecision',
    status: 'conference_deadline_too_far_rerouted_to_journal',
    routeApplied: true,
    selectedItem: fallbackItem,
    initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
    selectedTarget: {
      journalId: fallbackItem.profile.id,
      label: fallbackItem.profile.label,
      kind: fallbackItem.profile.kind,
    },
    deadlineAssessment: initialAssessment,
    journalFallbackConsidered: initialProfile.policy?.deadlineRouting?.journalFallbackIds || [],
    rationale: [
      `conference deadline is ${initialAssessment.daysToDeadline} days away, beyond ${initialAssessment.thresholdDays} day agent window`,
      `agent selected same-field journal fallback ${fallbackItem.profile.label}`,
    ],
  };
}

function rankProfiles({ target = null, hints = [], registry = null } = {}) {
  const profiles = registry?.profiles || JOURNAL_PROFILES.map((profile) => enrichProfile(profile));
  const text = tokenText([target, ...hints]);
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const targetText = normalizeText(target).toLowerCase();
  const broadJournalAutoSignal = /\b(broad impact|broad interest|interdisciplinary|scientific discovery|high impact|general audience|general interest)\b/.test(text);
  const csConferenceAutoSignal = /\b(computer science|artificial intelligence|ai|machine learning|deep learning|systems?|security|database|vision|nlp|graphics|architecture|programming language|software engineering|robotics)\b/.test(text);
  return profiles.map((profile, index) => {
    const broadGeneralJournalAutoSuppressed = !targetText
      && ['nature', 'science'].includes(profile.id)
      && !broadJournalAutoSignal;
    const baseScore = broadGeneralJournalAutoSuppressed ? 0 : profileScore(profile, text, tokens);
    const policyScore = (profile.policy?.disciplineTags || []).reduce((sum, tag) => {
      const normalized = normalizeText(tag).toLowerCase().replace(/_/g, ' ');
      return sum + (normalized && text.includes(normalized) ? 1 : 0);
    }, 0);
    const targetAliases = [
      profile.id,
      profile.label,
      ...(profile.aliases || []),
    ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
    const exactTargetBonus = targetText && targetAliases.includes(targetText) ? 10 : 0;
    const targetContainsBonus = targetText && targetAliases.some((alias) => (
      alias.length > 4 && (targetText.includes(alias) || alias.includes(targetText))
    )) ? 4 : 0;
    const conferenceAutoBonus = !targetText && csConferenceAutoSignal && profile.kind === 'conference' ? 1 : 0;
    const score = baseScore + policyScore + exactTargetBonus + conferenceAutoBonus;
    return {
      profile,
      score: score + targetContainsBonus,
      fitScore: Math.max(0, Math.min(100, 35 + (score + targetContainsBonus) * 10)),
      order: index,
    };
  }).sort((left, right) => right.score - left.score || left.order - right.order);
}

export function buildJournalConferenceRegistry({
  profiles = JOURNAL_PROFILES,
  createdAt = null,
} = {}) {
  const enrichedProfiles = profiles.map((profile) => enrichProfile(profile));
  const packet = {
    version: 1,
    kind: 'JournalConferenceRegistry',
    status: enrichedProfiles.length ? 'journal_conference_registry_ready' : 'journal_conference_registry_blocked',
    profileCount: enrichedProfiles.length,
    journalCount: enrichedProfiles.filter((profile) => profile.kind === 'journal').length,
    conferenceCount: enrichedProfiles.filter((profile) => profile.kind === 'conference').length,
    profileIds: enrichedProfiles.map((profile) => profile.id),
    profiles: enrichedProfiles,
    safety: {
      localOnly: true,
      generatedFromStaticProfiles: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalConferenceRegistryHash: hashPaperRecord('JournalConferenceRegistry', packet),
  };
}

export function buildTargetSelectionPolicy({
  paperTask = null,
  target = null,
  hints = [],
  registry = null,
  fallbackId = 'neurips',
  createdAt = null,
} = {}) {
  const resolvedTarget = normalizeText(target || paperTask?.venueTarget || '');
  const blockers = [];
  const ranked = rankProfiles({
    target: resolvedTarget,
    hints: [paperTask?.title, paperTask?.paperType, paperTask?.paperId, ...(hints || [])],
    registry,
  });
  const fallbackProfile = registry?.profiles?.find((profile) => profile.id === fallbackId)
    || enrichProfile(JOURNAL_PROFILES.find((profile) => profile.id === fallbackId) || JOURNAL_PROFILES[0]);
  const primaryBeforeDeadline = ranked.find((item) => item.score > 0)
    || { profile: fallbackProfile, score: 0, fitScore: 35 };
  const deadlineRoutingDecision = buildAgentDeadlineRoutingDecision({
    primaryItem: primaryBeforeDeadline,
    ranked,
    registry,
    resolvedTarget,
    createdAt,
  });
  const primary = deadlineRoutingDecision.selectedItem || primaryBeforeDeadline;
  if (!primary?.profile?.id) blockers.push('target_selection_profile_missing');
  const backupTargets = ranked
    .filter((item) => item.profile.id !== primary.profile.id)
    .filter((item) => item.score > 0 || resolvedTarget)
    .slice(0, 3)
    .map((item) => ({
      journalId: item.profile.id,
      label: item.profile.label,
      kind: item.profile.kind,
      fitScore: item.fitScore,
      rationale: `backup target matched ${item.score} venue/domain signals`,
    }));
  const {
    selectedItem: _deadlineSelectedItem,
    ...deadlineRoutingDecisionPacket
  } = deadlineRoutingDecision;
  const riskLevel = primary.fitScore >= 75 ? 'low' : primary.fitScore >= 55 ? 'medium' : 'high';
  const selectionMode = resolvedTarget ? 'operator_requested_target' : 'agent_auto_selected_from_idea';
  const packet = {
    version: 1,
    kind: 'TargetSelectionPolicy',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'target_selection_policy_blocked' : 'target_selection_policy_ready',
    requestedTarget: resolvedTarget || null,
    selectionMode,
    autoSelected: !resolvedTarget,
    journalConferenceRegistryHash: registry?.journalConferenceRegistryHash || null,
    primaryTarget: {
      journalId: primary.profile.id,
      label: primary.profile.label,
      kind: primary.profile.kind,
      fitScore: primary.fitScore,
      riskLevel,
      profile: primary.profile,
    },
    preDeadlinePrimaryTarget: {
      journalId: primaryBeforeDeadline.profile.id,
      label: primaryBeforeDeadline.profile.label,
      kind: primaryBeforeDeadline.profile.kind,
      fitScore: primaryBeforeDeadline.fitScore,
    },
    backupTargets,
    agentDeadlineRoutingDecision: deadlineRoutingDecisionPacket,
    rationale: [
      resolvedTarget ? `proposal requested target ${resolvedTarget}` : 'target auto-selected from proposal idea and discipline',
      `primary target selected by ${primary.score} venue/domain signals`,
      deadlineRoutingDecision.routeApplied
        ? `agent deadline routing changed primary target from ${primaryBeforeDeadline.profile.label} to ${primary.profile.label}`
        : `agent deadline routing status ${deadlineRoutingDecision.status}`,
      `risk level ${riskLevel} from fit score ${primary.fitScore}`,
    ],
    lock: {
      requiredAtProposalStage: true,
      lockedForAutopilot: blockers.length === 0,
      retargetRequiresNewProposalGate: true,
      targetSelectionMode: selectionMode,
    },
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      deterministicSelection: true,
      agentDeadlineRouting: true,
      regexDeadlineRouting: false,
      modelCallPerformed: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    targetSelectionPolicyHash: hashPaperRecord('TargetSelectionPolicy', packet),
  };
}

export function buildJournalTargetProfile({
  paperTask = null,
  target = null,
  hints = [],
  registry = null,
  targetSelectionPolicy = null,
  fallbackId = 'neurips',
  createdAt = null,
} = {}) {
  const resolvedTarget = normalizeText(
    target || paperTask?.venueTarget || targetSelectionPolicy?.primaryTarget?.label || '',
  );
  const blockers = [];
  if (!resolvedTarget) blockers.push('target_journal_required');
  if (targetSelectionPolicy?.status && targetSelectionPolicy.status !== 'target_selection_policy_ready') {
    blockers.push('target_selection_policy_not_ready');
  }
  const profile = targetSelectionPolicy?.primaryTarget?.profile
    || enrichProfile(resolveJournalProfile({
      target: resolvedTarget,
      hints: [
        paperTask?.title,
        paperTask?.paperType,
        paperTask?.paperId,
        ...(hints || []),
      ],
      fallbackId,
    }));
  const packet = {
    version: 1,
    kind: 'JournalTargetProfile',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'journal_target_profile_blocked' : 'journal_target_profile_ready',
    requestedTarget: resolvedTarget || null,
    journalConferenceRegistryHash: registry?.journalConferenceRegistryHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
    profile,
    requirements: profile.requirements || [],
    rubric: profile.rubric || [],
    venuePolicy: profile.policy || profilePolicy(profile),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      readsRegistryOnly: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalTargetProfileHash: hashPaperRecord('JournalTargetProfile', packet),
  };
}

export function buildJournalRubricPacket({
  paperTask = null,
  targetProfile,
  targetSelectionPolicy = null,
  venueRubricManager = null,
  refereePool = null,
  roundIndex = null,
  sourceRecord = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  const profile = targetProfile?.profile || {};
  const packet = {
    version: 1,
    kind: 'JournalRubricPacket',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    roundIndex: Number.isFinite(Number(roundIndex)) ? Number(roundIndex) : null,
    status: blockers.length ? 'journal_rubric_packet_blocked' : 'journal_rubric_packet_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || targetProfile?.targetSelectionPolicyHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    journalId: profile.id || null,
    journalLabel: profile.label || null,
    requirements: profile.requirements || [],
    rubric: profile.rubric || [],
    reviewStyle: profile.policy?.reviewStyle || null,
    evidenceRequirements: profile.policy?.evidenceRequirements || [],
    deskRejectRules: profile.policy?.deskRejectRules || [],
    acceptanceCriteria: [
      'fresh_referee_verdict_accept',
      'current_review_has_zero_findings',
      'open_referee_issue_count_is_zero',
      'post_revision_package_is_submit_ready',
      'research_verify_has_real_evidence',
      'reviewed_submit_controlled_executor_receipt_recorded',
    ],
    sourceRecordHash: sourceRecord?.hash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalRubricPacketHash: hashPaperRecord('JournalRubricPacket', packet),
  };
}

export function buildVenueRubricManager({
  paperTask = null,
  targetProfile,
  targetSelectionPolicy = null,
  roundIndex = null,
  sourceRecord = null,
  refereePool = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const dimensions = uniqueStrings([...(profile.rubric || []), ...(policy.evidenceRequirements || [])], 32)
    .map((id) => ({
      id,
      required: true,
      gate: id.includes('evidence') || id.includes('proof') || id.includes('theorem')
        ? 'venue_evidence_gate'
        : 'fresh_referee_review',
    }));
  const packet = {
    version: 1,
    kind: 'VenueRubricManager',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    roundIndex: Number.isFinite(Number(roundIndex)) ? Number(roundIndex) : null,
    status: blockers.length ? 'venue_rubric_manager_blocked' : 'venue_rubric_manager_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || targetProfile?.targetSelectionPolicyHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    journalId: profile.id || null,
    journalLabel: profile.label || null,
    reviewStyle: policy.reviewStyle,
    dimensions,
    evidenceRequirements: policy.evidenceRequirements || [],
    deskRejectRules: policy.deskRejectRules || [],
    template: policy.template,
    pageLimit: policy.pageLimit,
    anonymity: policy.anonymity,
    sourceRecordHash: sourceRecord?.hash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueRubricManagerHash: hashPaperRecord('VenueRubricManager', packet),
  };
}

export function buildFreshRefereePool({
  paperTask = null,
  targetProfile,
  roundIndex = 1,
  poolSize = 3,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const focus = uniqueStrings([...(profile.rubric || []), ...(policy.evidenceRequirements || [])], 16);
  const personas = Array.from({ length: Math.max(1, Math.min(5, Number(poolSize) || 3)) }, (_, index) => {
    const seed = hashPaperRecord('FreshRefereePersonaSeed', {
      paperId: paperTask?.paperId || targetProfile?.paperId || null,
      roundIndex,
      journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
      index,
    }).replace(/^sha256:/, '').slice(0, 12);
    return {
      id: `fresh_referee_${roundIndex}_${profile.id || 'journal'}_${index + 1}_${seed}`,
      role: index === 0 ? 'primary_fresh_referee' : 'secondary_fresh_referee',
      reviewStyle: policy.reviewStyle,
      focusAreas: focus.slice(index, index + 5).length ? focus.slice(index, index + 5) : focus.slice(0, 5),
      independentFromPriorRound: true,
    };
  });
  const packet = {
    version: 1,
    kind: 'FreshRefereePool',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    roundIndex: Number(roundIndex) || 1,
    status: blockers.length ? 'fresh_referee_pool_blocked' : 'fresh_referee_pool_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalId: profile.id || null,
    personas,
    primaryRefereeId: personas[0]?.id || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      deterministicPersonas: true,
      modelCallPerformed: false,
      humanReviewPerformed: false,
      independentReviewPerformed: false,
      academicAcceptanceAuthority: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    freshRefereePoolHash: hashPaperRecord('FreshRefereePool', packet),
  };
}

export function buildVenueEvidenceGate({
  paperTask = null,
  targetProfile,
  venueRubricManager = null,
  researchReport = null,
  packageResult = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  if (venueRubricManager?.status && venueRubricManager.status !== 'venue_rubric_manager_ready') {
    blockers.push('venue_rubric_manager_not_ready');
  }
  const realEvidencePresent = academicEvidenceReady(researchReport);
  if (!realEvidencePresent) blockers.push('research_verify_attested_academic_evidence_missing');
  if (packageResult && packageResult?.artifactPackage?.submitReady !== true) {
    blockers.push('submit_ready_package_required_for_evidence_gate');
  }
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const packet = {
    version: 1,
    kind: 'VenueEvidenceGate',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    status: blockers.length ? 'venue_evidence_gate_blocked' : 'venue_evidence_gate_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    journalId: profile.id || null,
    requiredEvidence: policy.evidenceRequirements || [],
    researchVerifyStatus: researchReport?.status || null,
    academicEvidenceStatus: researchReport?.academicEvidenceStatus || null,
    academicEvidenceEligible: researchReport?.academicEvidenceEligible === true,
    packageSubmitReady: packageResult?.artifactPackage?.submitReady === true,
    proposalSeedRejectedAsRealEvidence: researchReport?.status === 'proposal_seed_present',
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueEvidenceGateHash: hashPaperRecord('VenueEvidenceGate', packet),
  };
}

export function buildVenueLifecyclePolicy({
  paperTask = null,
  targetProfile,
  evidenceGate = null,
  lifecycle = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  if (evidenceGate?.status && evidenceGate.status !== 'venue_evidence_gate_ready') blockers.push('venue_evidence_gate_not_ready');
  const preflightReady = lifecycle?.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_ready_for_external_executor';
  const controlledReceiptReady = lifecycle?.controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded';
  if (lifecycle && !preflightReady) blockers.push('reviewed_submit_preflight_not_ready');
  if (lifecycle && !controlledReceiptReady) blockers.push('controlled_executor_receipt_not_recorded');
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const packet = {
    version: 1,
    kind: 'VenueLifecyclePolicy',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    status: blockers.length ? 'venue_lifecycle_policy_blocked' : 'venue_lifecycle_policy_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    journalId: profile.id || null,
    deadlinePolicy: policy.deadlinePolicy,
    localRefereeAcceptAllowed: false,
    localWorkflowClosureAllowed: blockers.length === 0,
    reviewedSubmitControlledHandoffAllowed: preflightReady && controlledReceiptReady,
    liveExternalSubmissionAllowed: false,
    liveSubmissionBoundary: policy.liveSubmissionBoundary,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueLifecyclePolicyHash: hashPaperRecord('VenueLifecyclePolicy', packet),
  };
}

export function buildJournalConferenceSystemPacket({
  paperTask = null,
  registry = null,
  targetSelectionPolicy = null,
  targetProfile = null,
  rubricPacket = null,
  venueRubricManager = null,
  freshRefereePool = null,
  evidenceGate = null,
  lifecyclePolicy = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (registry?.status !== 'journal_conference_registry_ready') blockers.push('journal_conference_registry_not_ready');
  if (targetSelectionPolicy?.status !== 'target_selection_policy_ready') blockers.push('target_selection_policy_not_ready');
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  if (rubricPacket?.status !== 'journal_rubric_packet_ready') blockers.push('journal_rubric_packet_not_ready');
  if (venueRubricManager?.status && venueRubricManager.status !== 'venue_rubric_manager_ready') {
    blockers.push('venue_rubric_manager_not_ready');
  }
  const packet = {
    version: 1,
    kind: 'JournalConferenceSystemPacket',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    status: blockers.length ? 'journal_conference_system_blocked' : 'journal_conference_system_ready',
    journalConferenceRegistryHash: registry?.journalConferenceRegistryHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalRubricPacketHash: rubricPacket?.journalRubricPacketHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: freshRefereePool?.freshRefereePoolHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    venueLifecyclePolicyHash: lifecyclePolicy?.venueLifecyclePolicyHash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      modelCallPerformed: false,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalConferenceSystemPacketHash: hashPaperRecord('JournalConferenceSystemPacket', packet),
  };
}

export function buildFreshRefereeVerdict({
  paperTask,
  targetProfile,
  rubricPacket,
  venueRubricManager = null,
  refereePool = null,
  evidenceGate = null,
  lifecyclePolicy = null,
  reviewReport,
  openIssueCount = 0,
  buildResult = null,
  packageResult = null,
  researchReport = null,
  lifecycle = null,
  roundIndex = 1,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('FreshRefereeVerdict requires paperTask');
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('target_journal_profile_not_ready');
  if (rubricPacket?.status !== 'journal_rubric_packet_ready') blockers.push('journal_rubric_packet_not_ready');
  if (reviewReport?.status !== 'agent_referee_review_clear' || Number(reviewReport?.findingCount || 0) > 0) {
    blockers.push('fresh_referee_review_not_clear');
  }
  if (Number(openIssueCount || 0) > 0) blockers.push('open_referee_issues_remaining');
  const submitReadyPackage = packageResult?.artifactPackage?.submitReady === true;
  if (!submitReadyPackage) blockers.push('post_revision_package_not_submit_ready');
  if (venueRubricManager?.status && venueRubricManager.status !== 'venue_rubric_manager_ready') {
    blockers.push('venue_rubric_manager_not_ready');
  }
  if (refereePool?.status && refereePool.status !== 'fresh_referee_pool_ready') {
    blockers.push('fresh_referee_pool_not_ready');
  }
  blockers.push(...reviewAuthorityBlockers({ refereePool }));
  if (evidenceGate?.status) {
    if (evidenceGate.status !== 'venue_evidence_gate_ready') {
      blockers.push(...(evidenceGate.blockers || ['venue_evidence_gate_not_ready']));
    }
  } else if (!academicEvidenceReady(researchReport)) {
    blockers.push('research_verify_attested_academic_evidence_missing');
  }
  if (lifecyclePolicy?.status && lifecyclePolicy.status !== 'venue_lifecycle_policy_ready') {
    blockers.push(...(lifecyclePolicy.blockers || ['venue_lifecycle_policy_not_ready']));
  }
  if (lifecycle?.reviewedSubmitPreflightPacket?.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (lifecycle?.controlledExecutorReceipt?.status !== 'controlled_external_executor_receipt_recorded') {
    blockers.push('controlled_executor_receipt_not_recorded');
  }
  const refereeSeed = hashPaperRecord('FreshRefereeSeed', {
    paperId: paperTask.paperId,
    roundIndex,
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalRubricPacketHash: rubricPacket?.journalRubricPacketHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    venueLifecyclePolicyHash: lifecyclePolicy?.venueLifecyclePolicyHash || null,
    reviewReportHash: reviewReport?.agentRefereeReviewReportHash || null,
  }).replace(/^sha256:/, '').slice(0, 16);
  const verdict = blockers.length ? 'revise' : 'accept';
  const packet = {
    version: 1,
    kind: 'FreshRefereeVerdict',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    roundIndex,
    refereeId: `fresh_referee_${roundIndex}_${targetProfile?.profile?.id || 'journal'}_${refereeSeed}`,
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalRubricPacketHash: rubricPacket?.journalRubricPacketHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    venueLifecyclePolicyHash: lifecyclePolicy?.venueLifecyclePolicyHash || null,
    reviewReportHash: reviewReport?.agentRefereeReviewReportHash || null,
    verdict,
    status: verdict === 'accept' ? 'fresh_referee_accept' : 'fresh_referee_revise',
    reviewStatus: reviewReport?.status || null,
    reviewFindingCount: Number(reviewReport?.findingCount || 0),
    openIssueCount: Number(openIssueCount || 0),
    packageSubmitReady: submitReadyPackage,
    researchVerifyStatus: researchReport?.status || null,
    venueEvidenceGateStatus: evidenceGate?.status || null,
    venueLifecyclePolicyStatus: lifecyclePolicy?.status || null,
    reviewedSubmitPreflightStatus: lifecycle?.reviewedSubmitPreflightPacket?.status || null,
    controlledExecutorReceiptStatus: lifecycle?.controlledExecutorReceipt?.status || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      freshRefereePersona: true,
      localOnly: true,
      modelCallPerformed: false,
      humanReviewPerformed: false,
      independentReviewPerformed: false,
      academicAcceptanceAuthority: false,
      sourceMutation: false,
      sqliteWrites: false,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    freshRefereeVerdictHash: hashPaperRecord('FreshRefereeVerdict', packet),
  };
}

export async function runJournalManageAdapter({
  root = null,
  runtimeRoot = null,
  row = null,
  target = null,
  hints = [],
  researchReport = null,
  packageResult = null,
  lifecycle = null,
  roundIndex = null,
  execute = false,
} = {}) {
  const registry = buildJournalConferenceRegistry();
  const targetSelectionPolicy = buildTargetSelectionPolicy({
    paperTask: row?.task || null,
    target: target || row?.task?.venueTarget || null,
    hints,
    registry,
  });
  const targetProfile = buildJournalTargetProfile({
    paperTask: row?.task || null,
    target: target || row?.task?.venueTarget || null,
    registry,
    targetSelectionPolicy,
    hints,
  });
  const freshRefereePool = buildFreshRefereePool({
    paperTask: row?.task || null,
    targetProfile,
    roundIndex: roundIndex || 1,
  });
  const venueRubricManager = buildVenueRubricManager({
    paperTask: row?.task || null,
    targetProfile,
    targetSelectionPolicy,
    roundIndex,
    refereePool: freshRefereePool,
  });
  const rubricPacket = buildJournalRubricPacket({
    paperTask: row?.task || null,
    targetProfile,
    targetSelectionPolicy,
    venueRubricManager,
    refereePool: freshRefereePool,
    roundIndex,
  });
  const evidenceGate = buildVenueEvidenceGate({
    paperTask: row?.task || null,
    targetProfile,
    venueRubricManager,
    researchReport,
    packageResult,
  });
  const lifecyclePolicy = buildVenueLifecyclePolicy({
    paperTask: row?.task || null,
    targetProfile,
    evidenceGate,
    lifecycle,
  });
  const systemPacket = buildJournalConferenceSystemPacket({
    paperTask: row?.task || null,
    registry,
    targetSelectionPolicy,
    targetProfile,
    rubricPacket,
    venueRubricManager,
    freshRefereePool,
    evidenceGate,
    lifecyclePolicy,
  });
  if (runtimeRoot && row?.task?.paperId && execute) {
    const dir = path.join(runtimeRoot, 'journal-manage', row.task.paperId);
    await ensureDir(dir);
    await writeJsonFile(path.join(dir, 'JOURNAL_CONFERENCE_REGISTRY.json'), registry);
    await writeJsonFile(path.join(dir, 'TARGET_SELECTION_POLICY.json'), targetSelectionPolicy);
    await writeJsonFile(path.join(dir, 'JOURNAL_TARGET_PROFILE.json'), targetProfile);
    await writeJsonFile(path.join(dir, 'JOURNAL_RUBRIC_PACKET.json'), rubricPacket);
    await writeJsonFile(path.join(dir, 'VENUE_RUBRIC_MANAGER.json'), venueRubricManager);
    await writeJsonFile(path.join(dir, 'FRESH_REFEREE_POOL.json'), freshRefereePool);
    await writeJsonFile(path.join(dir, 'VENUE_EVIDENCE_GATE.json'), evidenceGate);
    await writeJsonFile(path.join(dir, 'VENUE_LIFECYCLE_POLICY.json'), lifecyclePolicy);
    await writeJsonFile(path.join(dir, 'JOURNAL_CONFERENCE_SYSTEM_PACKET.json'), systemPacket);
  }
  const report = {
    version: 1,
    kind: 'JournalManageAdapterReport',
    paperId: row?.task?.paperId || null,
    taskKey: row?.task?.taskKey || null,
    status: systemPacket.status === 'journal_conference_system_ready'
      ? 'journal_manage_ready'
      : 'journal_manage_blocked',
    registry,
    targetSelectionPolicy,
    targetProfile,
    rubricPacket,
    venueRubricManager,
    freshRefereePool,
    evidenceGate,
    lifecyclePolicy,
    systemPacket,
    source: {
      runtimeDir: runtimeRoot && row?.task?.paperId
        ? relativePath(root || path.dirname(runtimeRoot), path.join(runtimeRoot, 'journal-manage', row.task.paperId))
        : null,
    },
    safety: {
      localOnly: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
  };
  return {
    ...report,
    journalManageAdapterReportHash: hashPaperRecord('JournalManageAdapterReport', report),
  };
}
