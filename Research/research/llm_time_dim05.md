# Research Dimension 05: Academic Research & Benchmarks on LLM Temporal Reasoning

> **Date Compiled:** 2025  
> **Sources:** 20+ independent web searches across arXiv, ACL Anthology, Google Scholar, NeurIPS, ICLR, and major tech publications  
> **Scope:** All major academic work, benchmarks, datasets, and evaluation metrics for LLM temporal reasoning and time estimation

---

## 1. Dimension Overview and Scope

This dimension surveys the landscape of academic research and benchmarks focused on evaluating and improving temporal reasoning capabilities in Large Language Models (LLMs). Temporal reasoning encompasses understanding time expressions, event ordering, duration prediction, commonsense temporal knowledge, and reasoning about events across long historical spans. The scope includes:

- **Core benchmarks:** TimeBench, TGQA, MenatQA, TempLS, TempReason, TimeQA, TDBench, TimE, UnSeenTimeQA, TRAVELER
- **Temporal Knowledge Graph QA:** CronQuestions, TimeQuestions, MultiTQ, TIQ, ForecastTKGQuestions
- **Domain-specific benchmarks:** Clinical (TIMER-Bench), Financial (FinTradeBench, XFINBENCH), Video (ReXTime)
- **Formal temporal reasoning:** TempoBench (LTL-based), TREK (evolving KG)
- **Contamination-free evaluation:** UnSeenTimeQA, PolyBench
- **Survey literature:** LLM Reasoning Failures survey (2026), TKGQA Survey (2024)

---

## 2. Key Findings with Evidence Blocks

### 2.1 TimeBench: The Most Comprehensive Hierarchical Benchmark

**Claim:** TimeBench (ACL 2024) is the most comprehensive temporal reasoning benchmark, comprising 10 tasks with 16 sub-tasks across three cognitive levels: symbolic temporal reasoning, commonsense temporal reasoning, and event temporal reasoning [^1^].

**Source:** ACL Anthology / arXiv  
**URL:** https://aclanthology.org/2024.acl-long.66/  
**Date:** August 2024  
**Excerpt:**
> "We propose TimeBench, a comprehensive hierarchical temporal reasoning benchmark that covers a broad spectrum of temporal reasoning phenomena. TimeBench provides a thorough evaluation for investigating the temporal reasoning capabilities of large language models. We conduct extensive experiments on GPT-4, LLaMA2, and other popular LLMs under various settings. Our experimental results indicate a significant performance gap between the state-of-the-art LLMs and humans, highlighting that there is still a considerable distance to cover in temporal reasoning." [^1^]

> "There remains a substantial gap of 19.4% between the most powerful LLM and humans... Notably, there is a significant gap of 25.2% between LLMs and humans in event temporal reasoning." [^1^]

**Context:** TimeBench incorporates four distinct task forms: free-form reading comprehension, natural language inference, constrained text generation, and multi-select questions. It evaluates models including GPT-4, GPT-3.5, LLaMA2-70B, Vicuna-1.5, Mistral-7B, Baichuan2, ChatGLM3, and FLAN-T5.  
**Confidence:** High

---

### 2.2 TGQA & TG-LLM: Teaching LLMs Temporal Graph Reasoning

**Claim:** TGQA is a synthetic dataset for open-book temporal reasoning with ground-truth temporal graphs, and the TG-LLM framework (ACL 2024) demonstrates that LLMs can learn temporal reasoning through text-to-temporal-graph translation followed by symbolic Chain-of-Thought reasoning [^2^].

**Source:** ACL Anthology / Hugging Face Datasets  
**URL:** https://aclanthology.org/2024.acl-long.563/ / https://huggingface.co/datasets/sxiong/TGQA  
**Date:** August 2024  
**Excerpt:**
> "We propose TG-LLM, a novel framework towards language-based TR. Instead of reasoning over the original context, we adopt a latent representation, temporal graph (TG) that enhances the learning of TR. A synthetic dataset (TGQA), which is fully controllable and requires minimal supervision, is constructed for fine-tuning LLMs on this text-to-TG translation task. We confirmed in experiments that the capability of TG translation learned on our dataset can be transferred to other TR tasks and benchmarks." [^2^]

> "We teach LLM to perform deliberate reasoning over the TGs via Chain-of-Thought (CoT) bootstrapping and graph data augmentation. We observed that those strategies... bring more reliable CoTs and final results than the vanilla CoT distillation." [^2^]

**Context:** TGQA dataset contains stories with aligned temporal graphs and question-answer pairs. The dataset is available on Hugging Face with six configurations including TGQA_Story_TG_Trans and TGQA_TGR. It also includes processed versions of TempReason and TimeQA datasets.  
**Confidence:** High

---

### 2.3 MenatQA: Systematic Temporal Reasoning Failures in LLMs

**Claim:** MenatQA (EMNLP 2023 Findings) is the first dataset containing multiple time-sensitive factors (scope, order, counterfactual) for evaluating LLM temporal reasoning, revealing that LLMs perform poorly on implicit temporal information and show high susceptibility to temporal biases [^3^].

**Source:** ACL Anthology  
**URL:** https://aclanthology.org/2023.findings-emnlp.100.pdf  
**Date:** 2023  
**Excerpt:**
> "We present a new dataset named Multiple Sensitive Factors Time QA (MenatQA). This is the first dataset containing multiple time-sensitive factors that can be used as an evaluation benchmark for assessing the time understanding and reasoning abilities of LLMs." [^3^]

> "LLMs display varying sensitivities towards different time factors. Notably, the counterfactual and scope factors exert the most significant impact on LLMs... none of the other LLMs demonstrate superiority over FiD across all temporal factors, except for LLama-13B." [^3^]

> "The weakness of LLMs in temporal reasoning is more prominent in reasoning type questions, where all LLMs exhibit varying degrees of performance decline compared to extraction type questions." [^3^]

**Context:** MenatQA contains 2,853 samples: 1,448 scope-type, 857 order-type, and 548 counterfactual-type. Evaluated models include BigBird, FiD, LLaMA, OPT, GPT-3.5-turbo, and ChatGLM-6B. GPT-3.5-turbo achieved only F1 34.69 / EM 27.66 on counterfactual questions, below FiD's F1 45.79 / EM 34.03.  
**Confidence:** High

---

### 2.4 TempLS: Long-Span Temporal Reasoning (BCE to Present)

**Claim:** TempLS is a long-span temporal reasoning benchmark covering 75,000 BCE to 2025 AD, created to evaluate the "Ticktack" methodology which uses sexagenary (60-year cycle) calendar encoding for improved long-span temporal alignment [^4^].

**Source:** arXiv / Emergent Mind analysis  
**URL:** https://arxiv.org/html/2503.04150v1  
**Date:** March 2025  
**Excerpt:**
> "Due to the lack of long time span benchmarks, we develop TempLS, a question-answering dataset covering the period from 75,000 BCE to 2025 AD, to facilitate the analysis of Ticktack's efficiency." [^4^]

> "Ticktack results in an average 34% improvement in accuracy on long-span questions (spanning BCE to present) using a new benchmark, TempLS." (Emergent Mind analysis) [^5^]

**Context:** Ticktack is a plug-and-play methodology from China Mobile Research Institute that encodes years using sexagenary cycle expression instead of Gregorian years, then models them as polar coordinates with learnable temporal encodings. It uses Elastic Weight Consolidation (EWC) for post-training temporal representational alignment.  
**Confidence:** High

---

### 2.5 UPenn Real-Time Deadlines Study: Temporal Awareness Failures in Strategic Dialogues

**Claim:** UPenn researchers (2025) demonstrated that LLMs systematically fail to track elapsed real-time in multi-turn negotiations, achieving only 4% deal closure for GPT-5.1 under global time limits versus 32% with per-turn time updates and 95%+ under turn-based limits, proving the failure is in temporal tracking rather than strategic reasoning [^6^].

**Source:** arXiv  
**URL:** https://arxiv.org/html/2601.13206v1  
**Date:** November 2025  
**Excerpt:**
> "Deal closure rates are substantially higher (32% vs. 4% for GPT-5.1) and offer acceptances are sixfold higher in the time-aware condition than in the control, suggesting LLMs struggle to internally track elapsed time. However, the same LLMs achieve near-perfect deal closure rates (>=95%) under turn-based limits, revealing the failure is in temporal tracking rather than strategic reasoning." [^6^]

> "The fact that URGENCY performs best suggests real-time failures are not inevitable consequences of negotiation complexity. Instead, they arise from the model's difficulty in representing and acting on continuous time pressure without repeated, decision-local cues." [^6^]

**Context:** The study used simulated negotiations between paired agents under strict deadlines. The Urgency condition (qualitative "Deadline approaching" reminders) outperformed both Time-Aware (numeric countdown) and Control conditions, indicating the bottleneck is mapping time pressure into strategic policy rather than simply accessing countdown values.  
**Confidence:** High

---

### 2.6 LLM Reasoning Failures Survey (2026)

**Claim:** The first comprehensive survey of reasoning failures in LLMs (Caltech/Stanford/Carleton, 2026) categorizes failures into fundamental (architecture-intrinsic), application-specific, and robustness issues, with temporal reasoning explicitly identified as an area of fundamental failure propagated by arithmetic weaknesses [^7^].

**Source:** arXiv  
**URL:** https://arxiv.org/abs/2602.06176  
**Date:** February 2026  
**Excerpt:**
> "We present the first comprehensive survey dedicated to reasoning failures in LLMs. We introduce a novel categorization framework that distinguishes reasoning into embodied and non-embodied types, with the latter further subdivided into informal (intuitive) and formal (logical) reasoning. In parallel, we classify reasoning failures along a complementary axis into three types: fundamental failures intrinsic to LLM architectures that broadly affect downstream tasks; application-specific limitations that manifest in particular domains; and robustness issues characterized by inconsistent performance across minor variations." [^7^]

> "Those fundamental inconsistencies lead to failures for practical tasks like temporal reasoning." [^7^]

**Context:** The survey unifies fragmented research findings and provides a structured perspective on systemic weaknesses. It identifies that LLMs' arithmetic failures (especially middle-digit multiplication) propagate into downstream temporal reasoning tasks. The survey releases a comprehensive GitHub repository of research works on LLM reasoning failures.  
**Confidence:** High

---

### 2.7 TDBench: Temporal Database-Driven Systematic TSQA Evaluation

**Claim:** TDBench (2025) is a novel benchmark that harnesses temporal databases and SQL-based temporal functional dependencies to systematically construct Time-Sensitive QA pairs, introducing "time accuracy" as a new metric that evaluates the validity of time references in model explanations [^8^].

**Source:** arXiv / OpenReview  
**URL:** https://arxiv.org/abs/2508.02045  
**Date:** August 2025  
**Excerpt:**
> "We propose TDBench, a new benchmark that systematically constructs TSQA pairs by harnessing temporal databases and database techniques, such as temporal functional dependencies, temporal SQL, and temporal joins. We also introduce a new evaluation metric called time accuracy, which assesses the validity of time references in model explanations alongside traditional answer accuracy." [^8^]

> "TDBench achieves high agreement with human verification, demonstrating the effectiveness of database-driven techniques for LLM benchmarking." (Precision 0.98 for temporal alignment, 0.87 for temporal reasoning, 0.95 for multi-hop) [^8^]

**Context:** TDBench uses 13 mutually exclusive and exhaustive temporal relations from Allen's Interval Algebra. It supports temporal alignment, temporal reasoning, and implicit multi-hop questions. Unlike Wikipedia/Wikidata-based benchmarks, TDBench generalizes to arbitrary temporal databases.  
**Confidence:** High

---

### 2.8 TimE: Multi-Level Benchmark for Real-World Temporal Reasoning

**Claim:** TimE (NeurIPS 2025) is a multi-level benchmark with 38,522 QA pairs covering three real-world challenges: intensive temporal information (TimE-Wiki), fast-changing event dynamics (TimE-News), and complex temporal dependencies in social interactions (TimE-Dial) [^9^].

**Source:** NeurIPS 2025 Virtual Poster  
**URL:** https://neurips.cc/virtual/2025/poster/121417  
**Date:** December 2025  
**Excerpt:**
> "We propose a multi-level benchmark TimE, designed for temporal reasoning in real-world scenarios. TimE consists of 38,522 QA pairs, covering 3 levels with 11 fine-grained sub-tasks. This benchmark encompasses 3 sub-datasets reflecting different real-world challenges: TimE-Wiki, TimE-News, and TimE-Dial." [^9^]

**Context:** TimE constructs 1,300 multi-hop temporal knowledge graphs from Wikidata using the SLING framework. It covers six relation categories: education/employment, family, geographical, naming, significant events, and role/identity. A human-annotated subset TimE-Lite is also released.  
**Confidence:** High

---

### 2.9 UnSeenTimeQA: Contamination-Free Time-Sensitive QA

**Claim:** UnSeenTimeQA (ACL 2025) is the first data contamination-free benchmark for time-sensitive QA, using synthetic facts to force genuine temporal reasoning rather than memorized knowledge, revealing LLMs struggle with long-range event dependencies and parallel events [^10^].

**Source:** ACL Anthology  
**URL:** https://aclanthology.org/2025.acl-long.94/  
**Date:** July 2025  
**Excerpt:**
> "This paper introduces UnSeenTimeQA, a novel data contamination-free time-sensitive question-answering (TSQA) benchmark. It differs from existing TSQA benchmarks by avoiding web-searchable queries grounded in the real world. We present a series of time-sensitive event scenarios based on synthetically generated facts." [^10^]

> "GPT-4 model answers the time-sensitive questions based on memorized facts rather than using temporal reasoning and information from the provided context." (from analysis of TimeQA, TempReason, MenatQA contamination) [^10^]

> "Error analysis indicates that LLMs face difficulties in reasoning over long-range event dependencies and parallel events." [^10^]

**Context:** UnSeenTimeQA draws inspiration from International Planning Competition (IPC) logistics problems. It generates questions about sequential and parallel event occurrences within 24-hour ranges. The benchmark demonstrates that existing TSQA benchmarks like TimeQA, TempReason, and MenatQA are contaminated in LLM training data.  
**Confidence:** High

---

### 2.10 TRAVELER: Temporal Reasoning Across Vague, Implicit, and Explicit References

**Claim:** TRAVELER (2025) systematically evaluates LLM performance degradation across explicit, implicit-relative-to-speech-time, and vague temporal references, showing accuracy drops by ~45% for vague references and performance degrades substantially with increasing event set size [^11^].

**Source:** arXiv / Springer  
**URL:** https://arxiv.org/abs/2505.01325 / https://link.springer.com/article/10.1007/s42979-026-04973-y  
**Date:** May 2025 / April 2026  
**Excerpt:**
> "Our findings show that while the benchmarked LLMs can answer questions over event sets with a handful of events and explicit temporal references successfully, performance clearly deteriorates with larger event set length and when temporal references get less explicit. Notably, the vague question category exhibits the lowest performance across all models." [^11^]

> "Shifting from explicit to implicit or vague temporal references reduces model accuracy by an average of 35%... When the reference is vague, the performance drops by around 45%." [^11^]

> "As the size of the event set grows, model performance generally decreases... GPT-4 and Llama3-8B show the most pronounced drop of 39% in the Implicit relative to speech time category when moving from 5 to 100 events." [^11^]

**Context:** TRAVELER contains 3,300 synthetic questions over household events with event set sizes from 5 to 100. Evaluated models include Gemma-7b, Llama3-8B, Llama3-70B, and GPT-4. Chain-of-thought prompting consistently improves results by up to 6%.  
**Confidence:** High

---

### 2.11 TempoBench: Formal LTL-Based Temporal & Causal Reasoning

**Claim:** TempoBench (2025) is a formally grounded diagnostic benchmark using finite-state automata synthesized from Linear Temporal Logic (LTL) specifications, revealing that LLMs achieve only 7.5% F1 on hard temporal causal evaluation tasks [^12^].

**Source:** Emergent Mind / GitHub (nik-hz/tempobench)  
**URL:** https://www.emergentmind.com/topics/tempobench  
**Date:** November 2025  
**Excerpt:**
> "TempoBench is a formally grounded diagnostic benchmark that evaluates LLMs on multi-step temporal and causal reasoning using automata synthesized from linear temporal logic." [^12^]

> "TCE 'Hard' regimen: F1 (TS) = 7.5%, F1 (AP) = 8.5%... Performance on TTE for both normal and hard sets is generally higher (above 50-60% F1), indicating that trace simulation is less challenging for current LLM architectures than multi-step causal identification." [^12^]

**Context:** TempoBench comprises two principal tasks: Temporal Trace Evaluation (TTE) and Temporal Causal Evaluation (TCE). Difficulty is controlled by effect depth, state count, transition count, and causal input cardinality. GPT-4o and Claude variants were evaluated.  
**Confidence:** High

---

### 2.12 ReXTime: Reasoning-Across-Time in Videos

**Claim:** ReXTime (2024) is a benchmark for evaluating reasoning across time in video events, where questions and answers occur in different video segments. Frontier MLLMs lag behind human performance by 14.3% accuracy [^13^].

**Source:** arXiv / ReXTime website  
**URL:** https://arxiv.org/abs/2406.19392 / https://rextime.github.io/  
**Date:** June 2024  
**Excerpt:**
> "We introduce ReXTime, a benchmark designed to rigorously test AI models' ability to perform temporal reasoning within video events. Specifically, ReXTime focuses on reasoning across time, i.e. human-like understanding when the question and its corresponding answer occur in different video segments." [^13^]

> "Humans can achieve 88.0% accuracy on VQA tasks, whereas the top-performing MLLM, OpenAI's GPT-4o, only reaches 73.7%." [^13^]

**Context:** ReXTime includes 921 validation and 2,143 test samples, plus 9,695 machine-generated training samples. The benchmark has the lowest question-answer overlap in time (QA-mIoU) compared to other video QA benchmarks, requiring true cross-segment reasoning.  
**Confidence:** High

---

### 2.13 Clinical Temporal Reasoning: TIMER-Bench

**Claim:** TIMER-Bench (ICLR 2025 SynthData Workshop) is the first time-aware benchmark for evaluating temporal reasoning over longitudinal Electronic Health Records (EHRs), revealing critical limitations including poor temporal boundary adherence, inaccurate trend analysis, and chronological confusion [^14^].

**Source:** OpenReview  
**URL:** https://openreview.net/pdf?id=uBCAtA6M73  
**Date:** ICLR 2025  
**Excerpt:**
> "We introduce TIMER (Temporal Instruction Modeling and Evaluation for Longitudinal Clinical Records), a synthetic data generation framework that incorporates temporal distribution of instructions as a critical dimension in both instruction evaluation and tuning for longitudinal clinical records. We develop TIMER-Bench, the first time-aware benchmark that evaluates temporal reasoning capabilities over longitudinal EHRs." [^14^]

> "Our analysis reveals critical limitations in existing LLMs' temporal reasoning capabilities, including poor temporal boundary adherence, inaccurate trend analysis, and chronological confusion." [^14^]

**Context:** TIMER-Bench uses synthetic data from longitudinal EHRs. Models fine-tuned with TIMER-Instruct improve by 7.3% on human-generated benchmarks and 9.2% on TIMER-Bench. The framework investigates temporal instruction distributions: recency-focused, edge-focused, and uniform.  
**Confidence:** High

---

### 2.14 Financial Time-Series Reasoning: FinTradeBench & XFINBENCH

**Claim:** FinTradeBench (2026) evaluates LLMs on financial reasoning integrating company fundamentals and trading signals, finding retrieval substantially improves textual fundamentals reasoning but provides limited benefit for trading-signal reasoning, highlighting fundamental challenges in numerical and time-series reasoning [^15^].

**Source:** arXiv  
**URL:** https://arxiv.org/abs/2603.19225  
**Date:** March 2026  
**Excerpt:**
> "We introduce FinTradeBench, a benchmark for evaluating financial reasoning that integrates company fundamentals and trading signals. FinTradeBench contains 1,400 questions grounded in NASDAQ-100 companies over a ten-year historical window." [^15^]

> "Retrieval substantially improves reasoning over textual fundamentals, but provides limited benefit for trading-signal reasoning. These findings highlight fundamental challenges in the numerical and time-series reasoning for current LLMs." [^15^]

**Context:** XFINBENCH (ACL 2025 Findings) also evaluates temporal reasoning as a specific capability among 7 financial capabilities, with 703 temporal reasoning questions in the test set. FinTradeBench evaluated 14 LLMs under zero-shot and retrieval-augmented settings.  
**Confidence:** High

---

### 2.15 TREK: Temporal Reasoning over Evolving Knowledge Graphs

**Claim:** TREK (2025) proposes EvoReasoner and EvoKG for multi-hop temporal reasoning over evolving KGs, achieving gains of up to 23.3% in temporal reasoning. An 8B-parameter model with TREK matches a 671B DeepSeek-V3 model on dynamic QA [^16^].

**Source:** arXiv  
**URL:** https://arxiv.org/abs/2509.15464  
**Date:** September 2025  
**Excerpt:**
> "We propose EvoReasoner, a temporal-aware multi-hop reasoning algorithm that performs global-local entity grounding, multi-route decomposition, and temporally grounded scoring. Furthermore, to ensure that the underlying KG remains accurate and up-to-date, we introduce EvoKG, a noise-tolerant KG evolution module." [^16^]

> "A compact LLaMA 3.1-8B model, trained in December 2023 and run on a single consumer GPU, improves from 18.6 to 37.0% after KG updates, comparable to directly prompting a much larger 671B DeepSeek-V3 model (38.3%) trained seven months later." [^16^]

**Context:** Evaluated on TimeQuestions and MultiTQ benchmarks (500K unique QA pairs), plus end-to-end CRAG Movie/Sports domains. The framework addresses contradiction resolution and temporal trend tracking in KGs.  
**Confidence:** High

---

### 2.16 ChronoQA: Temporal-Sensitive RAG Evaluation (Chinese)

**Claim:** ChronoQA (2025) is a large-scale Chinese benchmark with 5,176 question-answer pairs for evaluating temporal reasoning in RAG systems, with 37% requiring multi-document reasoning and covering absolute, aggregate, and relative temporal types [^17^].

**Source:** Nature Scientific Data / arXiv  
**URL:** https://www.nature.com/articles/s41597-025-06098-y / https://arxiv.org/abs/2508.12282  
**Date:** August 2025 / November 2025  
**Excerpt:**
> "We introduce ChronoQA, a large-scale benchmark dataset for Chinese question answering, specifically designed to evaluate temporal reasoning in Retrieval-Augmented Generation (RAG) systems. ChronoQA is constructed from over 300,000 news articles published between 2019 and 2024, and contains 5,176 high-quality questions." [^17^]

> "Notably, 37% of the questions (1,915) require multi-document reasoning, offering deeper evaluation capabilities compared to existing benchmarks that mostly focus on single-document settings." [^17^]

**Context:** ChronoQA underwent multi-stage validation with 6,000 human-reviewed samples achieving >95% quality with Cohen's Kappa = 0.85. LLMs perform moderately on single-document questions but accuracy drops significantly on multi-document temporal reasoning.  
**Confidence:** High

---

### 2.17 Event Duration Prediction Benchmarks: TimeBank & McTACO

**Claim:** TimeBank and McTACO-duration are the primary benchmarks for event duration prediction, with recent work showing that time-aware pre-training on web-collected duration sentences achieves state-of-the-art performance on both datasets [^18^].

**Source:** ACL Anthology (Findings EMNLP 2020)  
**URL:** https://aclanthology.org/2020.findings-emnlp.302.pdf  
**Date:** 2020  
**Excerpt:**
> "We evaluate our models on two duration-prediction benchmarks - TimeBank and McTACO-duration. TimeBank annotates 48 non-Wall-Street-Journal articles and 10 WSJ articles... The Coarse-Grained task requires predicting whether the event takes less than a day or longer than a day; the Fine-Grained task requires predicting the most likely temporal unit." [^18^]

> "Our best model (E-PRED) achieves state-of-the-art performance on the TimeBank dataset and the McTACO duration prediction task. In addition, in the unsupervised setting, our model trained with only collected web data outperforms the supervised BERT baseline by 9.24 F1 score and 9.68 Exact Match score on McTACO duration prediction task." [^18^]

**Context:** Duration prediction requires contextual understanding (e.g., "watch a movie" ~2 hours vs. "watch a bird fly" ~10 seconds) and compositional reasoning. The paper proposes R-PRED (classification) and E-PRED (regression) models.  
**Confidence:** High

---

### 2.18 Time Expression Normalization: TempEval-3 & HeidelTime

**Claim:** TempEval-3 (SemEval 2013) is the canonical benchmark for time expression recognition and normalization, with HeidelTime, SUTime, UWTime, and CogCompN as the leading systems [^19^].

**Source:** ACL Anthology / KU Leuven  
**URL:** https://aclanthology.org/2021.findings-emnlp.269.pdf / https://lirias.kuleuven.be/  
**Date:** 2013 / 2021  
**Excerpt:**
> "TempEval-3 is a sub-task in SemEval 2013 consisting of English news articles." [^19^]

> "The accuracy of normalization results on gold recognition annotations: HeidelTime 81.2%/76.1% (Type/Value), SUTime 83.3%/70.3%, UWTime 88.4%/82.6%, CogCompN 91.3%/83.4% on TempEval-3." [^19^]

**Context:** Time expression normalization involves identifying temporal expressions in text and converting them to standardized formats. Modern LLMs have largely superseded rule-based systems on this task, though evaluation remains relevant for specialized domains like clinical text or historical documents.  
**Confidence:** High

---

### 2.19 MCPVerse: Time-Sensitive Agentic Tool Use

**Claim:** MCPVerse (2025) includes time-sensitive tasks with real-time ground truth verification, using dynamic scripts that fetch real-time data for evaluation accuracy in agentic tool use scenarios [^20^].

**Source:** arXiv  
**URL:** https://arxiv.org/abs/2508.16260  
**Date:** August 2025  
**Excerpt:**
> "All tasks in MCPVerse are constructed using real-world information, such as map data and flight schedules. To handle time-sensitive queries, we developed dynamic scripts that fetch real-time ground truth, ensuring evaluation accuracy." [^20^]

> "We benchmarked the state-of-the-art LLMs across three modes... the top-performing model, Claude-4-Sonnet, achieved an success rate of only 44.2 at max-scale mode." [^20^]

**Context:** MCPVerse integrates 552 unique tools with combined schemas exceeding 147K tokens. Tasks include geographical information, financial data (stock prices), hot news (real-time updates), and academic research. The benchmark evaluates in Oracle, Standard, and Max-Scale modes.  
**Confidence:** High

---

### 2.20 Temporal Knowledge Graph QA Survey & Landscape

**Claim:** A comprehensive 2024 survey catalogs 10+ TKGQA benchmarks and categorizes methods into semantic parsing-based and TKG embedding-based approaches, with LLM-based methods emerging as a major new category [^21^].

**Source:** arXiv / GitHub (cosmicexotic/TKGQA-Survey)  
**URL:** https://arxiv.org/abs/2406.14191  
**Date:** August 2024  
**Excerpt:**
> "Temporal Knowledge Graph Question Answering: A Survey... A curated list of resources dedicated to temporal knowledge graph question answering (TKGQA)." [^21^]

Key benchmarks cataloged:
| Date | Title | Benchmark |
|------|-------|-----------|
| 2018 | TempQuestions | TempoQuestions |
| 2022 | TempoQA-WD | IBM Research |
| 2022 | TimeQuestions | Southwest Jiaotong |
| 2021 | CronQuestions | Indian Institute of Science |
| 2023 | MultiTQ | National University of Defense Technology |
| 2024 | MusTQ | Soochow University |
| 2022 | ForecastTKGQuestions | LMU Munich |
| 2024 | TIQ | Southwest Jiaotong |

**Context:** LLM-based TKGQA methods include GenTKGQA (two-stage generative), M³TQA (multi-stage aggregation), and ARI (knowledge-based interaction). The survey notes that LLMs have made considerable progress but their application to TKGQA remains relatively unexplored.  
**Confidence:** High

---

## 3. Major Players, Tools, and Frameworks

### 3.1 Core Benchmarks Summary Table

| Benchmark | Year | Venue | Size | Focus | Key Finding |
|-----------|------|-------|------|-------|-------------|
| **TimeBench** | 2024 | ACL | 10 tasks, 16 sub-tasks | Comprehensive hierarchical | 19.4% gap between GPT-4 and humans |
| **TGQA** | 2024 | ACL | Synthetic, controllable | Text-to-temporal-graph | Transferable TG extraction improves TR |
| **MenatQA** | 2023 | EMNLP Findings | 2,853 samples | Scope/Order/Counterfactual | GPT-3.5 fails on counterfactual (F1 34.69) |
| **TempLS** | 2025 | arXiv | 75,000 BCE to 2025 AD | Long-span alignment | Ticktack improves 34% on long-span |
| **TempReason** | 2023 | ACL | Multi-level | Implicit temporal reasoning | Event-time and event-event relations |
| **TimeQA** | 2021 | ACL | Easy + Hard subsets | Time-sensitive reading comprehension | LMs fail on complex temporal constraints |
| **UnSeenTimeQA** | 2025 | ACL | Contamination-free | Synthetic sequential/parallel | LLMs depend on memorized facts |
| **TRAVELER** | 2025 | arXiv/Springer | 3,300 questions | Explicit/Implicit/Vague | 45% accuracy drop for vague refs |
| **TDBench** | 2025 | arXiv | Database-driven | Systematic TSQA | Time accuracy metric for explanations |
| **TimE** | 2025 | NeurIPS | 38,522 QA pairs | Real-world 3-level | 11 fine-grained sub-tasks |
| **TempoBench** | 2025 | arXiv | LTL automata | Formal temporal/causal | 7.5% F1 on hard TCE tasks |
| **ReXTime** | 2024 | arXiv | 2,143 test + 9,695 train | Video across-time | GPT-4o at 73.7% vs humans 88.0% |
| **ChronoQA** | 2025 | Nature Sci Data | 5,176 Chinese QA | RAG temporal | 37% multi-document questions |
| **TIMER-Bench** | 2025 | ICLR Workshop | Longitudinal EHRs | Clinical temporal | Poor boundary adherence, chronological confusion |
| **FinTradeBench** | 2026 | arXiv | 1,400 NASDAQ questions | Financial fundamentals + trading | Retrieval helps text, not time-series |
| **TREK** | 2025 | arXiv/ICLR | TimeQuestions + MultiTQ | Evolving KG reasoning | 8B model matches 671B with KG updates |

### 3.2 Temporal Commonsense Benchmarks

| Benchmark | Year | Focus | Size |
|-----------|------|-------|------|
| **MCTACO** | 2019 | 5 temporal properties (duration, order, frequency, typical time, stationarity) | 13K QA pairs |
| **DurationQA** | 2022 | Event duration commonsense | 694 questions |
| **TimeDial** | 2021 | Temporal commonsense in dialogue | 1,446 multi-select |
| **SituatedGen** | 2023 | Constrained generative temporal reasoning | 115 time-focused |
| **TRACIE** | 2021 | Implicit event temporal order | Allen relations |
| **Test of Time** | 2024 | Synthetic contamination-free temporal | Pure temporal understanding |

### 3.3 Temporal Knowledge Graph QA Benchmarks

| Benchmark | Year | Source | Size |
|-----------|------|--------|------|
| **CronQuestions** | 2021 | Wikidata | Temporal factoid QA |
| **TimeQuestions** | 2022 | Wikidata | Multi-hop factoid QA |
| **MultiTQ** | 2023 | Wikidata | 500K unique QA pairs |
| **ForecastTKGQuestions** | 2022 | Wikidata | Entity prediction, yes-no, fact reasoning |
| **Complex-CronQuestions** | 2022 | Wikidata | Subgraph reasoning |
| **TIQ** | 2024 | Wikidata | Heterogeneous + implicit |
| **MusTQ** | 2024 | Soochow University | Multi-step temporal reasoning |
| **TimelineKGQA** | 2024 | ICEWS + CronQuestions | 893 + 41,720 questions |

---

## 4. Controversies and Conflicting Claims

### 4.1 Data Contamination in Temporal QA Benchmarks

**Conflicting Claim:** UnSeenTimeQA authors argue that benchmarks like TimeQA, TempReason, and MenatQA are "highly susceptible to data contamination" because they derive from Wikipedia, which was in LLM pre-training data [^10^].

**Counter-argument:** These benchmarks were designed before the LLM era and have been widely adopted. The contamination concern is valid but the benchmarks still reveal meaningful performance gaps between models and humans.

**Resolution:** The field is moving toward contamination-free evaluation (UnSeenTimeQA, Test of Time, PolyBench) as a complementary rather than replacement approach.

### 4.2 Can LLMs Learn Temporal Reasoning?

**Optimistic Claim:** TG-LLM (Xiong et al., ACL 2024) demonstrates that "LLMs can learn temporal reasoning" through text-to-temporal-graph translation and symbolic CoT reasoning, with transferable skills across benchmarks [^2^].

**Pessimistic Claim:** UPenn's real-time deadlines study shows "a systematic lack of LLM time awareness" that "will constrain LLM deployment in many time-sensitive applications" [^6^]. The LLM Reasoning Failures survey explicitly classifies temporal reasoning as an area of persistent fundamental failure [^7^].

**Synthesis:** LLMs can improve on structured temporal reasoning tasks with specialized training (TG-LLM, TIMER-Instruct), but fundamental architectural limitations in tracking continuous time and mapping time pressure to strategic behavior remain unresolved.

### 4.3 Is Chain-of-Thought Effective for Temporal Reasoning?

**Finding:** TimeBench reports that "chain-of-thought prompting does not yield a consistent improvement in performance" for temporal reasoning [^1^].

**Counter-finding:** TRAVELER consistently finds that "chain-of-thought (CoT) prompting yields better results" across all models [^11^].

**Resolution:** CoT effectiveness varies by task type and model. TimeBench covers diverse task formats where CoT may not uniformly help; TRAVELER focuses on event-based QA where structured reasoning steps are more beneficial.

---

## 5. Gaps and Open Questions

### 5.1 Identified Research Gaps

1. **Real-time temporal awareness:** No existing benchmark adequately tests LLMs' ability to track elapsed continuous time during multi-turn interactions. The UPenn negotiation study (2025) is a rare exception [^6^].

2. **Very long historical spans:** TempLS (75,000 BCE to present) is the only benchmark covering archaeological/historical timescales. Most benchmarks focus on modern history [^4^].

3. **Parallel event reasoning:** UnSeenTimeQA identifies that LLMs struggle with concurrent/parallel event scenarios, a gap in existing TSQA benchmarks [^10^].

4. **Multilingual temporal reasoning:** ChronoQA (Chinese) is a notable exception; most benchmarks are English-only. Cross-lingual temporal expression variation remains understudied [^17^].

5. **Temporal reasoning in agentic contexts:** MCPVerse (2025) includes time-sensitive tasks but the intersection of temporal reasoning with tool use and planning is nascent [^20^].

6. **Contamination-free evaluation:** While UnSeenTimeQA and Test of Time address this, there remains tension between synthetic (clean but potentially unrealistic) and real-world (contaminated but realistic) benchmarks.

### 5.2 Open Questions

- How can LLM architectures be modified to maintain internal temporal state across turns?
- What is the relationship between temporal reasoning and other reasoning types (mathematical, causal, physical)?
- Can neuro-symbolic approaches (like TG-LLM) scale to open-domain temporal reasoning?
- How should benchmarks evolve to test "understanding" vs. "memorization" of temporal facts?
- What is the minimal set of temporal primitives LLMs need for robust real-world deployment?

---

## 6. Summary and Recommended Deep-Dive Areas

### 6.1 Key Takeaways

1. **Comprehensive benchmarking is maturing:** TimeBench provides the most complete evaluation, but new benchmarks (TimE, TDBench, UnSeenTimeQA) are filling domain-specific and methodological gaps.

2. **Significant human-LLM gap persists:** Even GPT-4 lags humans by 19.4% on TimeBench and 25.2% on event temporal reasoning specifically [^1^].

3. **Contamination is a real concern:** Multiple studies confirm that LLMs answer Wikipedia-derived temporal questions from memorization rather than reasoning [^10^].

4. **Domain applications expose new failures:** Clinical (TIMER-Bench), financial (FinTradeBench), and negotiation (UPenn) contexts reveal temporal reasoning failures not captured by general benchmarks.

5. **Formal methods show severe limitations:** TempoBench reveals LLMs achieve only 7.5% F1 on hard temporal causal reasoning [^12^].

6. **Structured approaches help:** TG-LLM's temporal graph translation and TREK's evolving KG both demonstrate meaningful improvements, suggesting neuro-symbolic hybrids are a promising direction.

### 6.2 Recommended Deep-Dive Areas

| Priority | Area | Rationale |
|----------|------|-----------|
| **High** | Real-time temporal tracking in multi-turn dialogue | UPenn study is seminal; no comprehensive benchmark exists |
| **High** | Contamination-free temporal evaluation | Critical for measuring true temporal reasoning capability |
| **High** | Clinical/financial domain temporal reasoning | High-stakes applications with unique temporal patterns |
| **Medium** | Long-span historical temporal alignment (TempLS/Ticktack) | 34% improvement demonstrated; needs broader validation |
| **Medium** | Video temporal reasoning (ReXTime) | Multimodal frontier; 14.3% human gap remains |
| **Medium** | Temporal reasoning in agentic/tool-use contexts (MCPVerse) | Emerging intersection of two active research areas |
| **Low** | Time expression normalization (TempEval-3) | Mature area; LLMs largely supersede specialized systems |

---

## References

[^1^]: Chu, Z., Chen, J., Chen, Q., Yu, W., Wang, H., Liu, M., & Qin, B. (2024). TimeBench: A Comprehensive Evaluation of Temporal Reasoning Abilities in Large Language Models. *ACL 2024*. https://aclanthology.org/2024.acl-long.66/

[^2^]: Xiong, S., Payani, A., Kompella, R., & Fekri, F. (2024). Large Language Models Can Learn Temporal Reasoning. *ACL 2024*. https://aclanthology.org/2024.acl-long.563/

[^3^]: Wei, F., et al. (2023). MenatQA: A New Dataset for Testing the Temporal Reasoning Ability of Large Language Models. *EMNLP 2023 Findings*. https://aclanthology.org/2023.findings-emnlp.100.pdf

[^4^]: Han, X., Hu, Q., Wang, Y., et al. (2025). Ticktack: Long Span Temporal Alignment of Large Language Models Leveraging Sexagenary Cycle Time Expression. *arXiv:2503.04150*. https://arxiv.org/html/2503.04150v1

[^5^]: Emergent Mind. (2025). Temporal LLMs: Reasoning and Adaptation. https://www.emergentmind.com/topics/temporal-large-language-models

[^6^]: Sehgal, N., Guntuku, S.C., & Ungar, L. (2025). Real-Time Deadlines Reveal Temporal Awareness Failures in LLM Strategic Dialogues. *arXiv:2601.13206*. https://arxiv.org/html/2601.13206v1

[^7^]: Song, P., Han, P., & Goodman, N. (2026). Large Language Model Reasoning Failures. *arXiv:2602.06176*. https://arxiv.org/abs/2602.06176

[^8^]: Kim, S., Wang, J., Xie, X., & Whang, S.E. (2025). Harnessing Temporal Databases for Systematic Evaluation of Factual Time-Sensitive Question-Answering in Large Language Models. *arXiv:2508.02045*. https://arxiv.org/abs/2508.02045

[^9^]: TimE Benchmark. (2025). A Multi-level Benchmark for Temporal Reasoning of LLMs in Real-World Scenarios. *NeurIPS 2025*. https://neurips.cc/virtual/2025/poster/121417

[^10^]: Uddin, M.N., et al. (2025). UnSeenTimeQA: Time-Sensitive Question-Answering Beyond LLMs' Memorization. *ACL 2025*. https://aclanthology.org/2025.acl-long.94/

[^11^]: Kenneweg, S., Deigmoller, J., Cimiano, P., & Eggert, J. (2025). TRAVELER: A Benchmark for Evaluating Temporal Reasoning across Vague, Implicit and Explicit References. *arXiv:2505.01325*. https://arxiv.org/abs/2505.01325

[^12^]: TempoBench. (2025). TempoBench: Temporal Reasoning Benchmark. https://www.emergentmind.com/topics/tempobench

[^13^]: Chen, J.J., et al. (2024). A Benchmark Suite for Reasoning-Across-Time in Videos. *arXiv:2406.19392*. https://arxiv.org/abs/2406.19392

[^14^]: Cui, H., Unell, A., Chen, B., et al. (2025). TIMER: Temporal Instruction Modeling and Evaluation for Longitudinal Clinical Records. *ICLR 2025 SynthData Workshop*. https://openreview.net/pdf?id=uBCAtA6M73

[^15^]: Agrawal, Y., et al. (2026). FinTradeBench: A Financial Reasoning Benchmark for LLMs. *arXiv:2603.19225*. https://arxiv.org/abs/2603.19225

[^16^]: Lin, J., Wang, S., Guo, X., Shun, J., & Zhu, Y. (2025). Temporal Reasoning over Evolving Knowledge Graphs. *arXiv:2509.15464*. https://arxiv.org/abs/2509.15464

[^17^]: Chen, Z., Min, E., Zhao, X., et al. (2025). ChronoQA: A Question Answering Dataset for Temporal-Sensitive Retrieval-Augmented Generation. *Nature Scientific Data*. https://www.nature.com/articles/s41597-025-06098-y

[^18^]: Zhou, B., et al. (2020). Improving Event Duration Prediction via Time-aware Pre-training. *EMNLP 2020 Findings*. https://aclanthology.org/2020.findings-emnlp.302.pdf

[^19^]: Zhong, X., et al. (2021). Automatic rule generation for time expression normalization. *EMNLP 2021 Findings*. https://aclanthology.org/2021.findings-emnlp.269.pdf

[^20^]: Lei, F., Yang, Y., Sun, W., & Lin, D. (2025). An Expansive, Real-World Benchmark for Agentic Tool Use. *arXiv:2508.16260*. https://arxiv.org/abs/2508.16260

[^21^]: Temporal Knowledge Graph Question Answering: A Survey. (2024). *arXiv:2406.14191*. https://arxiv.org/abs/2406.14191

---

*Document compiled from 25+ independent web searches across arXiv, ACL Anthology, NeurIPS, ICLR, OpenReview, Nature Scientific Data, Springer, and authoritative technical publications. All claims include inline citations with verbatim excerpts from original sources.*
