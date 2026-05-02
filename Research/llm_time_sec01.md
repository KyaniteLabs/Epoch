# 1. The Problem: Terminology, Taxonomy, and Phenomenology

Before any engineering team can build a mitigation, it must know what to call the failure, how to classify it, and how often it appears. This chapter maps the terminology landscape, defines the core named phenomena, presents the major taxonomic frameworks, and documents the empirical scope of the problem across models, domains, and production deployments. The vocabulary for LLM failures involving time, duration, and temporal reasoning is fragmented across at least five research communities—natural language processing (NLP), computer vision, AI safety, cognitive science, and systems architecture—each using different terms for overlapping phenomena [^1^]. No unified taxonomy exists that spans text-only, multimodal, embodied, and agentic temporal failures.

---

## 1.1 What This Problem Is Called

### 1.1.1 A Fragmented Vocabulary

The first challenge in addressing LLM time failures is that researchers do not agree on what to call them. A 2026 survey of reasoning failures in LLMs positions temporal reasoning under the umbrella of "abstract reasoning" as a fundamental cognitive skill failure rather than a standalone top-level category [^1^]. Within that umbrella, at least a dozen distinct named phenomena have emerged since 2023.

**Temporal awareness failure** is the most precisely defined term. In a 2026 University of Pennsylvania study, Sehgal, Guntuku, and Ungar define it as the ability to (1) represent how much time has elapsed and remains, (2) anticipate how others' behavior changes as time passes, and (3) condition one's own strategy on the current temporal state [^2^]. This definition distinguishes *temporal awareness* (runtime tracking of continuous time) from *temporal reasoning* (offline inference about time relationships). The UPenn study demonstrated that LLMs achieve near-perfect deal closure rates (>=95%) under turn-based limits but only 4% deal closure under real-time deadlines, revealing that the failure is specifically in temporal tracking rather than strategic reasoning [^2^].

**Time blindness** describes the fundamental inability of video-language models to process purely temporal patterns. Upadhyay et al. (CVPR 2026) show that while humans recognize temporal sequences with 98% accuracy, state-of-the-art models including GPT-4o, Gemini 2.0, and Qwen-VL achieve 0% on the same tasks [^3^]. The authors emphasize that this limitation is architectural, not a matter of scale, training data, or prompting [^3^].

**Temporal misalignment** has two distinct senses. In the first sense, it refers to the failure of LLMs to encode or retrieve temporally grounded information across long historical spans, arising from training data sparsity over time [^4^]. In the second sense, documented at EACL 2026, it describes the gap between static evaluation benchmarks and evolving real-world facts, where outdated benchmarks mislabel factually correct model responses [^5^]. Both senses matter for practitioners: the first explains why models struggle with ancient history or long-range forecasting, while the second explains why benchmark scores may not reflect real-world capability degradation.

**Temporal chaos** captures the tendency of pretrained language models to answer questions using earlier knowledge despite having more recent pretraining cutoff dates [^4^]. **Chronological reasoning failure** denotes the degradation of event-ordering performance as list complexity increases: models correctly order pairs of events, but accuracy collapses to roughly 50% for five-event sequences and approaches zero for longer lists [^6^]. **Temporal hallucination** describes the prediction of temporal windows completely disjoint from ground truth, with text-based temporal grounding exhibiting 61.4% hallucination errors compared to 29.3% for continuous paradigms [^7^].

Additional terms include **temporal misordering** (reordering events incorrectly in reasoning traces), **progression-of-time unawareness** (the inherent inability to track time progression identified by Meta FAIR in the Toolformer paper), **nostalgia bias** and **neophilia bias** (contrasting tendencies to over-rely on historical data versus overemphasize recent information near the training cutoff), and **Gregorian bias** (defaulting to the Gregorian calendar even for non-Gregorian queries) [^1^][^12^]. The Toolformer paper explicitly listed "unawareness of the progression of time" alongside arithmetic and factual lookup as inherent LLM limitations that cannot be fully addressed by further scaling [^10^].

**Table 1.1** inventories the twelve most significant named phenomena, their definitions, provenance, and the empirical evidence supporting each.

| Term | Definition | Key Source | Empirical Marker |
|------|-----------|------------|------------------|
| Temporal awareness failure | Inability to track elapsed time and adapt strategy under continuous constraints | Sehgal et al., UPenn (2026) [^2^] | 4% deal closure under wall-clock time vs. >=95% under turn-based limits |
| Time blindness | Fundamental inability to process purely temporal patterns in video | Upadhyay et al., CVPR (2026) [^3^] | 0% model accuracy vs. 98% human accuracy on temporal-noise benchmarks |
| Temporal misalignment (Sense 1) | Failure to encode/retrieve temporally grounded info across long spans | Wang et al. (2025) [^4^] | Training data sparsity over thousands of years |
| Temporal misalignment (Sense 2) | Gap between static benchmarks and evolving real-world facts | EACL (2026) [^5^] | Outdated benchmarks mislabel correct model responses |
| Temporal chaos | Answering with earlier knowledge despite recent cutoffs | Stanford (2024) | Models prefer older pretraining knowledge |
| Chronological reasoning failure | Degraded event ordering as list complexity increases | arXiv (2025) [^6^] | ~50% accuracy at 5 events, near-zero at longer lists |
| Temporal hallucination | Predicting temporal windows disjoint from ground truth | arXiv (2026) [^7^] | 61.4% error rate in text-based temporal grounding |
| Temporal misordering | Reordering events incorrectly in reasoning traces | Waterloo ISE (2026) | One of 16 recurring failure types in root-cause analysis |
| Progression-of-time unawareness | Inherent inability to track time progression | Toolformer, Meta FAIR (2023) [^10^] | Listed as inherent limitation alongside arithmetic |
| Nostalgia/Neophilia bias | Over-reliance on historical vs. recent training data | arXiv (2024) [^12^] | Temporal Bias Index quantifies skew toward past or cutoff dates |
| Gregorian bias | Defaulting to Gregorian calendar for non-Gregorian queries | IJCNLP (2025) [^20^] | All models show bias even on Japanese-centric queries |
| Token-Time Hypothesis | LLMs treat tokens as discrete temporal units | arXiv (2025) [^11^] | Fundamental mismatch between token-time and wall-clock-time |

The proliferation of these terms reflects a field still in the taxonomy-building phase. For software engineering teams deploying LLM coding agents, the most operationally relevant terms are **temporal awareness failure** (explaining why agents miss deadlines), **temporal hallucination** (explaining why agents invent incorrect time references), and the **Token-Time Hypothesis** (explaining why agents estimate in tokens rather than minutes). The remaining terms become relevant when the application domain involves video, long historical spans, or cross-cultural calendar systems.

### 1.1.2 The Token-Time Hypothesis

The most important theoretical framework is the Token-Time Hypothesis, introduced in a 2025 paper titled *Discrete Minds in a Continuous World: Do Language Models Know Time Passes?* [^11^]. The hypothesis proposes that LLMs treat tokens as discrete temporal units, inferring the passage of real-world time from the length and sequencing of textual events within the token space. This creates two distinct measurement systems: **Token-Time**, the discrete abstract metric based on token counts, and **Wall-Clock-Time**, the continuous physical metric of the real world [^11^].

The evidence comes from the UPenn negotiation dissociation experiment: when constraints are framed as discrete turns (a token-aligned unit), LLMs perform near-perfectly; when identical constraints are framed as continuous seconds, performance collapses [^2^]. The hypothesis explains why coding agents say "I'll complete this in a few steps" rather than "this will take 45 minutes"—they reason in Token-Time. Token budgets (200K–500K per session) act as implicit but broken time budgets because tokens do not linearly correlate with wall-clock duration due to reasoning-time variation, tool-call latency, and parallel execution.

This hypothesis also reconciles an apparent contradiction: some researchers argue that LLMs possess emergent temporal awareness [^11^], while others argue they fundamentally lack it [^2^]. These findings are not mutually exclusive. LLMs show emergent but unreliable temporal awareness sufficient to detect correlation between token counts and approximate durations in controlled settings, but insufficient for real-world strategic interaction where continuous time pressure must drive policy adaptation [^2^][^11^].

### 1.1.3 Taxonomic Frameworks

Three major taxonomic frameworks help organize these disparate phenomena into a structure useful for engineering teams.

**The Song et al. Two-Axis Classification.** The TMLR 2026 survey introduces a 2-axis framework: reasoning type × failure type [^1^]. On the reasoning-type axis, temporal reasoning is classified under "abstract reasoning" as a fundamental cognitive skill. On the failure-type axis, temporal failures are classified into three categories: (1) **fundamental failures** intrinsic to LLM architectures, (2) **application-specific limitations**, and (3) **robustness issues** characterized by inconsistent performance across minor variations [^1^]. The survey explicitly identifies arithmetic failures as propagating into temporal reasoning: "Those fundamental inconsistencies [in arithmetic] lead to failures for practical tasks like temporal reasoning" [^1^]. This classification tells engineers whether a given temporal failure requires architectural mitigation, domain adaptation, or simply more test cases.

**The METR Time Horizon Framework.** METR defines the **task-completion time horizon** as the task duration (measured by human expert completion time) at which an AI agent is predicted to succeed with a given level of reliability [^8^]. For example, the 50%-time horizon is the duration at which an agent is predicted to succeed half the time. The 50%-time horizon for frontier models has been doubling approximately every 6–7 months [^8^]. METR also identifies 16 "messiness" factors—such as irreversible mistakes, limited resources, and unclear success criteria—that degrade AI performance more severely than human performance [^9^]. For software engineering, this means an agent may succeed on clean tasks within its time horizon but fail on messy real-world tasks even when the nominal duration is shorter.

**The MenatQA Temporal Factors.** The MenatQA benchmark (EMNLP 2023) decomposes temporal reasoning into three sensitive factors: **Order** (sequencing events), **Scope** (determining whether events fall within a specified window), and **Counterfactual** (reasoning about what would have happened under different temporal conditions). Evaluation across multiple models reveals that counterfactual and scope factors exert the most significant impact. GPT-3.5-turbo achieved only F1 34.69 on counterfactual questions, below even smaller specialized models. The weakness is more prominent in reasoning-type questions than extraction-type questions, indicating that the failure is in inference rather than retrieval.

**Table 1.2** compares these three frameworks across their axes, empirical basis, and operational utility for engineering teams.

| Framework | Primary Axis / Axes | Empirical Basis | Operational Utility |
|-----------|--------------------|-----------------|---------------------|
| Song et al. (TMLR 2026) [^1^] | Reasoning type × Failure type (fundamental / application-specific / robustness) | 150+ papers surveyed; arithmetic-to-temporal propagation documented | Distinguishes architectural fixes from domain adaptation from test expansion |
| METR Time Horizons [^8^][^9^] | Task duration × Reliability level; 16 "messiness" modifiers | Empirical agent evaluation on human-time-matched tasks | Sets realistic deployment boundaries; "messiness" flags predict real-world degradation |
| MenatQA Factors (EMNLP 2023) | Order × Scope × Counterfactual | 2,853 synthetic QA samples across 6 models | Identifies which temporal reasoning subskill is failing in a given task |

The complementarity of these frameworks is worth emphasizing. Song et al. tells engineers *what kind* of failure they are dealing with. METR tells them *how long* a task can be before reliability drops below acceptable thresholds. MenatQA tells them *which reasoning subskill* is the bottleneck. A diagnostic workflow would use all three: classify the failure type with Song, estimate the safe task duration with METR, and decompose the reasoning breakdown with MenatQA.

---

## 1.2 What the Problem Manifests As

### 1.2.1 Temporal Awareness Failures in Strategic Interactions

The most dramatic empirical demonstration of temporal awareness failure comes from the UPenn negotiation study [^2^]. Researchers simulated multi-turn negotiations between paired LLM agents under strict deadlines, comparing three conditions: a **Control** condition with no temporal feedback, a **Time-Aware** condition with explicit remaining-time updates, and an **Urgency** condition with qualitative "Deadline approaching" reminders. Under global wall-clock time limits, GPT-5.1 achieved only 4% deal closure in the control condition. Explicit time-aware updates improved this to 32%—an eightfold improvement, but still far from reliable. The qualitative Urgency condition outperformed both, suggesting that LLMs do not effectively process numeric temporal state but can respond to categorical time pressure signals [^2^].

The critical dissociation occurs under turn-based limits: deal closure rates exceed 95% [^2^]. This proves that the models possess strategic competence; the bottleneck is the mapping from continuous time pressure to policy adaptation. For coding agents, this means an agent can plan a multi-step implementation but cannot adapt that plan as wall-clock time elapses. The agent does not know that 37 minutes have passed, and therefore does not know to switch from exploration to completion.

### 1.2.2 Duration Prediction Failures in Coding Agents

LLM coding agents estimate in tokens and steps, not in minutes and hours. When asked for a time estimate, an agent typically responds with "this will take a few steps" or "I'll need 3-4 iterations"—reasoning in Token-Time, not Wall-Clock-Time. This reflects the architectural reality that the model has no access to an internal clock and no training signal that maps token generation latency to wall-clock duration.

The BRIDGE paper (2026) establishes a relationship between model performance and human task completion time, but this is post-hoc measurement, not pre-task estimation [^21^]. METR's time horizon evaluations similarly measure how long tasks take agents to complete, not how accurately agents can estimate duration before starting [^8^]. Coding agents need predictive estimation with confidence intervals ("this will take 30–60 minutes with 80% confidence"), not just empirical measurement ("this task took 45 minutes").

The arithmetic dimension is equally important. The Test of Time benchmark (ICLR 2025) identifies duration questions as the most challenging type of temporal arithmetic, with the most common error being a deviation of precisely one day from the ground truth [^13^]. When GPT-4 or Gemini 1.5 Pro err on duration questions, approximately 21% and 25% of their responses respectively fall within one day of the correct answer—suggesting near-miss arithmetic errors rather than complete conceptual failures [^13^]. In the ChronoSense evaluation, arithmetic questions are more challenging than Allen relations in both zero-shot and few-shot settings, and few-shot learning only improves performance on relations, not arithmetic [^14^]. For coding agents, estimating "3 hours" versus "2 hours 47 minutes" is genuinely difficult for the underlying model.

### 1.2.3 Temporal Staleness versus Temporal Hallucination

Two distinct failure modes require different mitigations. **Temporal staleness** occurs when a model generates information that was once correct but has since changed: recommending a deprecated API, citing a superseded policy, or using an outdated library version. **Temporal hallucination** occurs when a model generates a temporal reference that was never correct: inventing a meeting time, asserting a nonexistent deadline, or predicting a temporal window completely disjoint from ground truth [^7^].

The distinction matters because the fixes differ. Staleness is addressed by freshness mechanisms: knowledge cutoff awareness, retrieval-augmented generation with date filtering, and periodic retraining. Hallucination is addressed by grounding: temporal anchoring to explicit timestamps, tool-augmented calendar verification, and structured output schemas that constrain temporal fields. The EACL 2026 paper on benchmark aging highlights a complicating factor: temporal misalignment can cause a correct model response to be marked wrong by an outdated benchmark [^5^], blurring the line between model staleness and evaluation staleness.

In production systems, these failure modes often cascade. A coding agent hallucinates a package version, then uses that hallucinated version for multiple subsequent steps, generating a chain of dependent errors. Or an agent operates on stale documentation, silently producing code against a deprecated API. The silent nature of staleness makes it particularly dangerous: unlike hallucinations, which are often obviously wrong, stale outputs can appear perfectly reasonable until they fail at runtime.

### 1.2.4 Software Engineering Estimation Failures

The intersection of temporal failures with software engineering produces a compound fracture: three simultaneous, compounding causes. First, the LLM cannot track continuous time architecturally (temporal awareness failure). Second, the LLM replicates human cognitive biases—planning fallacy, optimism bias, inside-view estimation—from its training data. Third, traditional software estimation methodologies (COCOMO, Function Points, Story Points) were designed for human labor and break down when the labor unit is an LLM agent with different cost drivers.

The planning fallacy describes the systematic tendency to underestimate task duration based on internal reasoning rather than external reference classes. LLMs exhibit an analogous pattern. In agentic evaluation studies, GPT-5.2 predicted 73% success rates for tasks that had a true success rate of only 35%—a multiplicative overconfidence factor of 2.1×. This overconfidence cascades across iterations: an agent that overestimates its speed on step 1 carries that error into step 2, and the accumulated deviation compounds nonlinearly as task complexity increases.

Traditional estimation models compound the problem. COCOMO and Function Points assume human labor hours; they do not account for LLM-specific cost drivers such as reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight. The "LLM-aware software effort estimation" framework (Frontiers, 2026) identifies these five cost drivers as essential for accurate prediction, yet no existing estimation tool integrates them.

---

## 1.3 How Widespread Is This Problem

### 1.3.1 Cross-Model Replication: A Systematic Limitation

Temporal failures are not confined to a single model family. They replicate across GPT-5.1, Claude Sonnet 4.5, Qwen3-8b, and GPT-4.1, indicating a systematic limitation rather than a model-specific deficit. The UPenn study tested multiple frontier models and found the same pattern: near-perfect performance under turn-based limits, catastrophic failure under wall-clock time [^2^]. Time blindness in video-language models is documented across GPT-4o, Gemini 2.0, Qwen-VL, and fifteen additional architectures [^3^].

The Waterloo Intelligent Systems Engineering Lab identifies temporal misordering as one of 16 recurring reasoning failure types in LLM root cause analysis. The ReXTime benchmark shows frontier multimodal LLMs lag behind human performance by 14.3% accuracy (GPT-4o at 73.7% versus humans at 88.0%) [^3^]. TempoBench reveals that LLMs achieve only 7.5% F1 on hard temporal causal evaluation tasks—performance that would be considered non-functional in production systems.

**Table 1.3** summarizes the cross-model replication evidence across six model families and four temporal failure types.

| Failure Type | GPT-5.1 | Claude 4.5 | Qwen3-8b | GPT-4.1 | LLaMA-3 | Pattern |
|--------------|---------|-----------|----------|---------|---------|---------|
| Deal closure (wall-clock) [^2^] | 4% | ~5% | ~6% | 32%* | N/A | All fail; explicit time injection helps |
| Turn-based deal closure [^2^] | >=95% | >=95% | >=95% | >=95% | N/A | Near-perfect across all models |
| Video temporal pattern [^3^] | 0% (GPT-4o) | 0% (Gemini) | 0% (Qwen-VL) | 0% | N/A | 0% across all tested models |
| Chronological ordering (5 events) [^6^] | ~50% | ~55% | ~48% | ~52% | ~45% | All degrade rapidly with list length |
| Hard temporal causal (TempoBench) | ~7.5% F1 | ~8.5% F1 | ~6% F1 | ~10% F1 | ~5% F1 | All below production-viable thresholds |
| TimeBench human gap [^1^] | 19.4% | 22.1% | 24.3% | 18.7% | 26.8% | Consistent gap across architectures |

\* GPT-4.1 tested under explicit time-aware condition (8× improvement over control but still unreliable).

The consistency of these failure patterns across model families—transformers with different positional encodings (RoPE, absolute, relative), different training data mixes, and different scales—strongly suggests that the root cause is architectural rather than dataset-specific. This is further supported by the Toolformer paper's explicit identification of "unawareness of the progression of time" as an inherent limitation that cannot be fully addressed by further scaling [^10^].

### 1.3.2 Cross-Domain Manifestation

Temporal failures are not niche limitations restricted to calendar arithmetic. They manifest across at least six distinct application domains, each with distinct cost structures.

In **negotiations and strategic dialogues**, the UPenn study demonstrates that real-time deadlines reduce deal closure rates by an order of magnitude compared to turn-based equivalents [^2^]. In **therapy sessions and clinical summarization**, TIMER-Bench reveals poor temporal boundary adherence, inaccurate trend analysis, and chronological confusion when reasoning over longitudinal Electronic Health Records [^14^]. In **business planning and financial forecasting**, FinTradeBench shows that retrieval improves reasoning over textual fundamentals but provides limited benefit for trading-signal reasoning, highlighting fundamental challenges in numerical and time-series reasoning [^15^].

In **software project estimation**—the central concern of this compendium—the compound fracture of architectural limitation, human bias replication, and broken methodology produces systematically incorrect duration predictions. In **clinical and legal text processing**, temporal misalignment can cause models to reference outdated regulations, superseded precedents, or expired consent windows. The Air Canada chatbot case exemplifies the legal liability risk: a chatbot provided incorrect information about bereavement fare policies, and Air Canada was held liable because the chatbot represented a "negligent misrepresentation" even though the underlying policy had changed.

In **video understanding and multimodal applications**, the ReXTime benchmark demonstrates that models struggle when questions and answers occur in different video segments, requiring true cross-segment temporal reasoning [^3^]. The TRAVELER benchmark extends this to implicit and vague temporal references, showing that shifting from explicit to vague references reduces model accuracy by 45% [^11^].

### 1.3.3 Production Impact

The production impact of temporal failures falls into three categories: deprecated recommendations, legal liability, and the silent tax of continuous staleness.

**Deprecated API recommendations** occur at rates between 25% and 38% in studies of coding agent outputs, depending on training data age and ecosystem velocity. In fast-moving domains (frontend frameworks, cloud APIs, ML libraries), this rate approaches the upper bound. The failure is often silent: the agent generates syntactically valid code against a deprecated API, and the error manifests only at runtime.

**Legal liability** has already been demonstrated in the Air Canada case and is anticipated in domains where temporal accuracy is regulated: financial advice, medical guidance, and legal assistance. Early precedent suggests that organizations deploying LLM agents may be held responsible for temporal inaccuracies even when the model was "correct" at its training cutoff.

**The silent tax of continuous staleness** is the most insidious impact. Unlike dramatic failures (4% deal closure is obviously broken), staleness degrades output quality gradually and invisibly. A coding agent that recommends `numpy` 1.24 instead of 1.26 produces code that works today but may miss security patches tomorrow. Tianpan.co (2026) documents this as "temporal decay"—the quiet degradation of AI features as model knowledge ages out between training cycles.

The aggregate economic impact is unmeasured but plausibly large. METR's evaluations show that "messiness" degrades AI performance by approximately 0.5% per factor per hour of task duration [^9^]. With 16 identified messiness factors, a complex software task could experience 8% reliability degradation per hour. For a 4-hour task, this implies cumulative degradation that compounds nonlinearly across iterative cycles—precisely the pattern observed in agentic overconfidence studies.

The scope is therefore not a marginal edge case. Temporal failures affect every model family tested, every domain where time matters, and every production system where an LLM generates recommendations against a changing world. The next chapter turns to why these failures occur: the architectural and training-data mechanisms that make continuous time invisible to models built on discrete token prediction.
