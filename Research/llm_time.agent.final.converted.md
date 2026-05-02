# LLM Temporal Reasoning & Time Estimation: Research Compendium and Build Documentation

---

# Executive Summary

Large language models (LLMs) have demonstrated remarkable competence across coding, reasoning, and creative tasks, yet they consistently fail at one of the most basic operations in software engineering: estimating how long a task will take. This document investigates why that failure occurs, compiles the research record, and delivers end-to-end build specifications for an external tool that closes the gap.

The problem is not a minor inconvenience. It is a systematic, cross-model limitation known as **temporal awareness failure** — the inability to track elapsed wall-clock time and adapt strategy accordingly ^1^. In a controlled negotiation study, GPT-5.1 achieved 99% deal closure under turn-based limits but collapsed to 4% under real-time deadlines ^1^. The same pattern holds across GPT-4.1, Claude Sonnet 4.5, and Qwen3-8b: when time is measured in tokens (turns, steps, iterations), models perform; when time is measured in seconds, they fail catastrophically ^1^. This is not a training-data deficit. The root cause is architectural. Transformers are stateless between forward passes; their positional encodings encode sequence order, not temporal duration; and self-attention is theoretically incapable of the accumulation and counting operations required for continuous time tracking ^2^ ^1^. No amount of scale overcomes these constraints.

In software engineering, this architectural limitation creates a **compound fracture**. First, the LLM cannot track continuous time. Second, it replicates human cognitive biases — planning fallacy, optimism bias, inside-view estimation — from its training data ^3^. Third, traditional estimation methodologies (COCOMO, Function Points, Story Points) were designed for human labor and break down when the "worker" is an LLM agent with wholly different cost drivers ^4^. The result is that current coding agents operate without any wall-clock estimation capability. They use token budgets (200K–500K tokens per session) as broken implicit time budgets, reasoning in "steps" rather than minutes, and routinely deliver estimates that are off by orders of magnitude ^5^.

The fix is not to make LLMs "better at time" through further training. It is to make time **legible to LLMs** through structured external representations and tool delegation ^6^. The evidence is consistent: explicit time-state injection improves performance 8× (from 4% to 32% deal closure) ^1^. Calendar and calculator tools, as demonstrated in Meta AI's Toolformer (NeurIPS 2023), substantially outperform base models on temporal benchmarks ^7^. The Model Context Protocol (MCP) ecosystem — with 97 million monthly SDK downloads and 10,000+ public servers — provides the dominant integration standard for such external tools ^5^. MCP achieves universal integration across Claude Code, Cursor, VS Code, Windsurf, Cline, and other agentic environments ^5^.

Yet a critical gap remains. No existing MCP server combines clock time, calendar mathematics, software estimation algorithms, and historical data integration into a single system. The MCP ecosystem has narrow time servers (clock, timezone, duration) and isolated software estimation research, but nothing bridges these domains. This **estimation infrastructure vacuum** means coding agents still cannot request a reliable duration estimate even when they recognize the need for one ^8^ ^9^.

This document is organized in two parts to address both the "why" and the "how." **Part I (Chapters 1–4)** is the research compendium. Chapter 1 maps the terminology landscape — temporal awareness failure, time blindness, temporal misalignment — and presents the major taxonomic frameworks. Chapter 2 provides the deep architectural analysis, tracing five interlocking causes from statelessness to attention entropy. Chapter 3 examines the software engineering impact, documenting how COCOMO, Story Points, and agentic token budgets all fail in LLM-assisted workflows. Chapter 4 reviews the current fixes — Toolformer, MCP servers, explicit time injection, urgency cues, and neuro-symbolic hybrids — with their efficacy and limitations.

**Part II (Chapters 5–9)** is the complete build documentation for a 5-layer Time Estimation MCP Server. Chapter 5 presents the architectural blueprint: Core Temporal (clock, timezone, duration), Calendar Math (business-day arithmetic, holiday-aware scheduling), Software Estimation (PERT, parametric models, LLM-aware effort units), Data Integration (Jira, Toggl, Asana APIs for reference-class forecasting), and Advanced Analytics (confidence intervals, risk classification, token-to-time mapping). Chapter 6 covers implementation in Python with `pendulum`, `workalendar`, and structured MCP tool definitions. Chapter 7 details integration patterns for major agentic IDEs. Chapter 8 defines the evaluation framework, security posture, and production deployment patterns. Chapter 9 provides a complete reference implementation with code, configuration, and runbooks.

The server follows four design principles derived from the research: (1) make time legible through structured external representations, not by teaching the LLM temporal reasoning; (2) return both numeric estimates and categorical classifications, because qualitative urgency cues outperform numeric countdowns for LLM policy adaptation ^3^; (3) bridge token-space and time-space with explicit mappings that account for reasoning variation, tool-call latency, and API throughput ^5^; and (4) prioritize historical actual-vs-estimated data from project management systems over purely algorithmic models, because reference-class forecasting captures the idiosyncratic "messiness" of real-world LLM-assisted development better than COCOMO ^3^ ^4^.

For the busy reader, the essential takeaway is this: LLMs cannot estimate time because their architecture prevents continuous duration tracking, not because they lack data or prompting. External tool delegation via MCP servers is the only viable near-term fix, yielding an 8× improvement with proper time-state injection. This document provides the first integrated build specification for that tool — closing an estimation infrastructure vacuum that affects every LLM-assisted software project today.


---

# 1. The Problem: Terminology, Taxonomy, and Phenomenology

Before any engineering team can build a mitigation, it must know what to call the failure, how to classify it, and how often it appears. This chapter maps the terminology landscape, defines the core named phenomena, presents the major taxonomic frameworks, and documents the empirical scope of the problem across models, domains, and production deployments. The vocabulary for LLM failures involving time, duration, and temporal reasoning is fragmented across at least five research communities—natural language processing (NLP), computer vision, AI safety, cognitive science, and systems architecture—each using different terms for overlapping phenomena ^2^. No unified taxonomy exists that spans text-only, multimodal, embodied, and agentic temporal failures.

---

## 1.1 What This Problem Is Called

### 1.1.1 A Fragmented Vocabulary

The first challenge in addressing LLM time failures is that researchers do not agree on what to call them. A 2026 survey of reasoning failures in LLMs positions temporal reasoning under the umbrella of "abstract reasoning" as a fundamental cognitive skill failure rather than a standalone top-level category ^2^. Within that umbrella, at least a dozen distinct named phenomena have emerged since 2023.

**Temporal awareness failure** is the most precisely defined term. In a 2026 University of Pennsylvania study, Sehgal, Guntuku, and Ungar define it as the ability to (1) represent how much time has elapsed and remains, (2) anticipate how others' behavior changes as time passes, and (3) condition one's own strategy on the current temporal state ^1^. This definition distinguishes *temporal awareness* (runtime tracking of continuous time) from *temporal reasoning* (offline inference about time relationships). The UPenn study demonstrated that LLMs achieve near-perfect deal closure rates (>=95%) under turn-based limits but only 4% deal closure under real-time deadlines, revealing that the failure is specifically in temporal tracking rather than strategic reasoning ^1^.

**Time blindness** describes the fundamental inability of video-language models to process purely temporal patterns. Upadhyay et al. (CVPR 2026) show that while humans recognize temporal sequences with 98% accuracy, state-of-the-art models including GPT-4o, Gemini 2.0, and Qwen-VL achieve 0% on the same tasks ^8^. The authors emphasize that this limitation is architectural, not a matter of scale, training data, or prompting ^8^.

**Temporal misalignment** has two distinct senses. In the first sense, it refers to the failure of LLMs to encode or retrieve temporally grounded information across long historical spans, arising from training data sparsity over time ^3^. In the second sense, documented at EACL 2026, it describes the gap between static evaluation benchmarks and evolving real-world facts, where outdated benchmarks mislabel factually correct model responses ^6^. Both senses matter for practitioners: the first explains why models struggle with ancient history or long-range forecasting, while the second explains why benchmark scores may not reflect real-world capability degradation.

**Temporal chaos** captures the tendency of pretrained language models to answer questions using earlier knowledge despite having more recent pretraining cutoff dates ^3^. **Chronological reasoning failure** denotes the degradation of event-ordering performance as list complexity increases: models correctly order pairs of events, but accuracy collapses to roughly 50% for five-event sequences and approaches zero for longer lists ^4^. **Temporal hallucination** describes the prediction of temporal windows completely disjoint from ground truth, with text-based temporal grounding exhibiting 61.4% hallucination errors compared to 29.3% for continuous paradigms ^10^.

Additional terms include **temporal misordering** (reordering events incorrectly in reasoning traces), **progression-of-time unawareness** (the inherent inability to track time progression identified by Meta FAIR in the Toolformer paper), **nostalgia bias** and **neophilia bias** (contrasting tendencies to over-rely on historical data versus overemphasize recent information near the training cutoff), and **Gregorian bias** (defaulting to the Gregorian calendar even for non-Gregorian queries) ^2^ ^11^. The Toolformer paper explicitly listed "unawareness of the progression of time" alongside arithmetic and factual lookup as inherent LLM limitations that cannot be fully addressed by further scaling ^12^.

**Table 1.1** inventories the twelve most significant named phenomena, their definitions, provenance, and the empirical evidence supporting each.

| Term | Definition | Key Source | Empirical Marker |
|------|-----------|------------|------------------|
| Temporal awareness failure | Inability to track elapsed time and adapt strategy under continuous constraints | Sehgal et al., UPenn (2026) ^1^| 4% deal closure under wall-clock time vs. >=95% under turn-based limits |
| Time blindness | Fundamental inability to process purely temporal patterns in video | Upadhyay et al., CVPR (2026) ^8^| 0% model accuracy vs. 98% human accuracy on temporal-noise benchmarks |
| Temporal misalignment (Sense 1) | Failure to encode/retrieve temporally grounded info across long spans | Wang et al. (2025) ^3^| Training data sparsity over thousands of years |
| Temporal misalignment (Sense 2) | Gap between static benchmarks and evolving real-world facts | EACL (2026) ^6^| Outdated benchmarks mislabel correct model responses |
| Temporal chaos | Answering with earlier knowledge despite recent cutoffs | Stanford (2024) | Models prefer older pretraining knowledge |
| Chronological reasoning failure | Degraded event ordering as list complexity increases | arXiv (2025) ^4^| ~50% accuracy at 5 events, near-zero at longer lists |
| Temporal hallucination | Predicting temporal windows disjoint from ground truth | arXiv (2026) ^10^| 61.4% error rate in text-based temporal grounding |
| Temporal misordering | Reordering events incorrectly in reasoning traces | Waterloo ISE (2026) | One of 16 recurring failure types in root-cause analysis |
| Progression-of-time unawareness | Inherent inability to track time progression | Toolformer, Meta FAIR (2023) ^12^| Listed as inherent limitation alongside arithmetic |
| Nostalgia/Neophilia bias | Over-reliance on historical vs. recent training data | arXiv (2024) ^11^| Temporal Bias Index quantifies skew toward past or cutoff dates |
| Gregorian bias | Defaulting to Gregorian calendar for non-Gregorian queries | IJCNLP (2025) ^13^| All models show bias even on Japanese-centric queries |
| Token-Time Hypothesis | LLMs treat tokens as discrete temporal units | arXiv (2025) ^14^| Fundamental mismatch between token-time and wall-clock-time |

The proliferation of these terms reflects a field still in the taxonomy-building phase. For software engineering teams deploying LLM coding agents, the most operationally relevant terms are **temporal awareness failure** (explaining why agents miss deadlines), **temporal hallucination** (explaining why agents invent incorrect time references), and the **Token-Time Hypothesis** (explaining why agents estimate in tokens rather than minutes). The remaining terms become relevant when the application domain involves video, long historical spans, or cross-cultural calendar systems.

### 1.1.2 The Token-Time Hypothesis

The most important theoretical framework is the Token-Time Hypothesis, introduced in a 2025 paper titled *Discrete Minds in a Continuous World: Do Language Models Know Time Passes?* ^14^. The hypothesis proposes that LLMs treat tokens as discrete temporal units, inferring the passage of real-world time from the length and sequencing of textual events within the token space. This creates two distinct measurement systems: **Token-Time**, the discrete abstract metric based on token counts, and **Wall-Clock-Time**, the continuous physical metric of the real world ^14^.

The evidence comes from the UPenn negotiation dissociation experiment: when constraints are framed as discrete turns (a token-aligned unit), LLMs perform near-perfectly; when identical constraints are framed as continuous seconds, performance collapses ^1^. The hypothesis explains why coding agents say "I'll complete this in a few steps" rather than "this will take 45 minutes"—they reason in Token-Time. Token budgets (200K–500K per session) act as implicit but broken time budgets because tokens do not linearly correlate with wall-clock duration due to reasoning-time variation, tool-call latency, and parallel execution.

This hypothesis also reconciles an apparent contradiction: some researchers argue that LLMs possess emergent temporal awareness ^14^, while others argue they fundamentally lack it ^1^. These findings are not mutually exclusive. LLMs show emergent but unreliable temporal awareness sufficient to detect correlation between token counts and approximate durations in controlled settings, but insufficient for real-world strategic interaction where continuous time pressure must drive policy adaptation ^1^ ^14^.

### 1.1.3 Taxonomic Frameworks

Three major taxonomic frameworks help organize these disparate phenomena into a structure useful for engineering teams.

**The Song et al. Two-Axis Classification.** The TMLR 2026 survey introduces a 2-axis framework: reasoning type × failure type ^2^. On the reasoning-type axis, temporal reasoning is classified under "abstract reasoning" as a fundamental cognitive skill. On the failure-type axis, temporal failures are classified into three categories: (1) **fundamental failures** intrinsic to LLM architectures, (2) **application-specific limitations**, and (3) **robustness issues** characterized by inconsistent performance across minor variations ^2^. The survey explicitly identifies arithmetic failures as propagating into temporal reasoning: "Those fundamental inconsistencies [in arithmetic] lead to failures for practical tasks like temporal reasoning" ^2^. This classification tells engineers whether a given temporal failure requires architectural mitigation, domain adaptation, or simply more test cases.

**The METR Time Horizon Framework.** METR defines the **task-completion time horizon** as the task duration (measured by human expert completion time) at which an AI agent is predicted to succeed with a given level of reliability ^5^. For example, the 50%-time horizon is the duration at which an agent is predicted to succeed half the time. The 50%-time horizon for frontier models has been doubling approximately every 6–7 months ^5^. METR also identifies 16 "messiness" factors—such as irreversible mistakes, limited resources, and unclear success criteria—that degrade AI performance more severely than human performance ^9^. For software engineering, this means an agent may succeed on clean tasks within its time horizon but fail on messy real-world tasks even when the nominal duration is shorter.

**The MenatQA Temporal Factors.** The MenatQA benchmark (EMNLP 2023) decomposes temporal reasoning into three sensitive factors: **Order** (sequencing events), **Scope** (determining whether events fall within a specified window), and **Counterfactual** (reasoning about what would have happened under different temporal conditions). Evaluation across multiple models reveals that counterfactual and scope factors exert the most significant impact. GPT-3.5-turbo achieved only F1 34.69 on counterfactual questions, below even smaller specialized models. The weakness is more prominent in reasoning-type questions than extraction-type questions, indicating that the failure is in inference rather than retrieval.

**Table 1.2** compares these three frameworks across their axes, empirical basis, and operational utility for engineering teams.

| Framework | Primary Axis / Axes | Empirical Basis | Operational Utility |
|-----------|--------------------|-----------------|---------------------|
| Song et al. (TMLR 2026) ^2^| Reasoning type × Failure type (fundamental / application-specific / robustness) | 150+ papers surveyed; arithmetic-to-temporal propagation documented | Distinguishes architectural fixes from domain adaptation from test expansion |
| METR Time Horizons ^5^ ^9^| Task duration × Reliability level; 16 "messiness" modifiers | Empirical agent evaluation on human-time-matched tasks | Sets realistic deployment boundaries; "messiness" flags predict real-world degradation |
| MenatQA Factors (EMNLP 2023) | Order × Scope × Counterfactual | 2,853 synthetic QA samples across 6 models | Identifies which temporal reasoning subskill is failing in a given task |

The complementarity of these frameworks is worth emphasizing. Song et al. tells engineers *what kind* of failure they are dealing with. METR tells them *how long* a task can be before reliability drops below acceptable thresholds. MenatQA tells them *which reasoning subskill* is the bottleneck. A diagnostic workflow would use all three: classify the failure type with Song, estimate the safe task duration with METR, and decompose the reasoning breakdown with MenatQA.

---

## 1.2 What the Problem Manifests As

### 1.2.1 Temporal Awareness Failures in Strategic Interactions

The most dramatic empirical demonstration of temporal awareness failure comes from the UPenn negotiation study ^1^. Researchers simulated multi-turn negotiations between paired LLM agents under strict deadlines, comparing three conditions: a **Control** condition with no temporal feedback, a **Time-Aware** condition with explicit remaining-time updates, and an **Urgency** condition with qualitative "Deadline approaching" reminders. Under global wall-clock time limits, GPT-5.1 achieved only 4% deal closure in the control condition. Explicit time-aware updates improved this to 32%—an eightfold improvement, but still far from reliable. The qualitative Urgency condition outperformed both, suggesting that LLMs do not effectively process numeric temporal state but can respond to categorical time pressure signals ^1^.

The critical dissociation occurs under turn-based limits: deal closure rates exceed 95% ^1^. This proves that the models possess strategic competence; the bottleneck is the mapping from continuous time pressure to policy adaptation. For coding agents, this means an agent can plan a multi-step implementation but cannot adapt that plan as wall-clock time elapses. The agent does not know that 37 minutes have passed, and therefore does not know to switch from exploration to completion.

### 1.2.2 Duration Prediction Failures in Coding Agents

LLM coding agents estimate in tokens and steps, not in minutes and hours. When asked for a time estimate, an agent typically responds with "this will take a few steps" or "I'll need 3-4 iterations"—reasoning in Token-Time, not Wall-Clock-Time. This reflects the architectural reality that the model has no access to an internal clock and no training signal that maps token generation latency to wall-clock duration.

The BRIDGE paper (2026) establishes a relationship between model performance and human task completion time, but this is post-hoc measurement, not pre-task estimation ^15^. METR's time horizon evaluations similarly measure how long tasks take agents to complete, not how accurately agents can estimate duration before starting ^5^. Coding agents need predictive estimation with confidence intervals ("this will take 30–60 minutes with 80% confidence"), not just empirical measurement ("this task took 45 minutes").

The arithmetic dimension is equally important. The Test of Time benchmark (ICLR 2025) identifies duration questions as the most challenging type of temporal arithmetic, with the most common error being a deviation of precisely one day from the ground truth ^16^. When GPT-4 or Gemini 1.5 Pro err on duration questions, approximately 21% and 25% of their responses respectively fall within one day of the correct answer—suggesting near-miss arithmetic errors rather than complete conceptual failures ^16^. In the ChronoSense evaluation, arithmetic questions are more challenging than Allen relations in both zero-shot and few-shot settings, and few-shot learning only improves performance on relations, not arithmetic ^17^. For coding agents, estimating "3 hours" versus "2 hours 47 minutes" is genuinely difficult for the underlying model.

### 1.2.3 Temporal Staleness versus Temporal Hallucination

Two distinct failure modes require different mitigations. **Temporal staleness** occurs when a model generates information that was once correct but has since changed: recommending a deprecated API, citing a superseded policy, or using an outdated library version. **Temporal hallucination** occurs when a model generates a temporal reference that was never correct: inventing a meeting time, asserting a nonexistent deadline, or predicting a temporal window completely disjoint from ground truth ^10^.

The distinction matters because the fixes differ. Staleness is addressed by freshness mechanisms: knowledge cutoff awareness, retrieval-augmented generation with date filtering, and periodic retraining. Hallucination is addressed by grounding: temporal anchoring to explicit timestamps, tool-augmented calendar verification, and structured output schemas that constrain temporal fields. The EACL 2026 paper on benchmark aging highlights a complicating factor: temporal misalignment can cause a correct model response to be marked wrong by an outdated benchmark ^6^, blurring the line between model staleness and evaluation staleness.

In production systems, these failure modes often cascade. A coding agent hallucinates a package version, then uses that hallucinated version for multiple subsequent steps, generating a chain of dependent errors. Or an agent operates on stale documentation, silently producing code against a deprecated API. The silent nature of staleness makes it particularly dangerous: unlike hallucinations, which are often obviously wrong, stale outputs can appear perfectly reasonable until they fail at runtime.

### 1.2.4 Software Engineering Estimation Failures

The intersection of temporal failures with software engineering produces a compound fracture: three simultaneous, compounding causes. First, the LLM cannot track continuous time architecturally (temporal awareness failure). Second, the LLM replicates human cognitive biases—planning fallacy, optimism bias, inside-view estimation—from its training data. Third, traditional software estimation methodologies (COCOMO, Function Points, Story Points) were designed for human labor and break down when the labor unit is an LLM agent with different cost drivers.

The planning fallacy describes the systematic tendency to underestimate task duration based on internal reasoning rather than external reference classes. LLMs exhibit an analogous pattern. In agentic evaluation studies, GPT-5.2 predicted 73% success rates for tasks that had a true success rate of only 35%—a multiplicative overconfidence factor of 2.1×. This overconfidence cascades across iterations: an agent that overestimates its speed on step 1 carries that error into step 2, and the accumulated deviation compounds nonlinearly as task complexity increases.

Traditional estimation models compound the problem. COCOMO and Function Points assume human labor hours; they do not account for LLM-specific cost drivers such as reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight. The "LLM-aware software effort estimation" framework (Frontiers, 2026) identifies these five cost drivers as essential for accurate prediction, yet no existing estimation tool integrates them.

---

## 1.3 How Widespread Is This Problem

### 1.3.1 Cross-Model Replication: A Systematic Limitation

Temporal failures are not confined to a single model family. They replicate across GPT-5.1, Claude Sonnet 4.5, Qwen3-8b, and GPT-4.1, indicating a systematic limitation rather than a model-specific deficit. The UPenn study tested multiple frontier models and found the same pattern: near-perfect performance under turn-based limits, catastrophic failure under wall-clock time ^1^. Time blindness in video-language models is documented across GPT-4o, Gemini 2.0, Qwen-VL, and fifteen additional architectures ^8^.

The Waterloo Intelligent Systems Engineering Lab identifies temporal misordering as one of 16 recurring reasoning failure types in LLM root cause analysis. The ReXTime benchmark shows frontier multimodal LLMs lag behind human performance by 14.3% accuracy (GPT-4o at 73.7% versus humans at 88.0%) ^8^. TempoBench reveals that LLMs achieve only 7.5% F1 on hard temporal causal evaluation tasks—performance that would be considered non-functional in production systems.

**Table 1.3** summarizes the cross-model replication evidence across six model families and four temporal failure types.

| Failure Type | GPT-5.1 | Claude 4.5 | Qwen3-8b | GPT-4.1 | LLaMA-3 | Pattern |
|--------------|---------|-----------|----------|---------|---------|---------|
| Deal closure (wall-clock) ^1^| 4% | ~5% | ~6% | 32%* | N/A | All fail; explicit time injection helps |
| Turn-based deal closure ^1^| >=95% | >=95% | >=95% | >=95% | N/A | Near-perfect across all models |
| Video temporal pattern ^8^| 0% (GPT-4o) | 0% (Gemini) | 0% (Qwen-VL) | 0% | N/A | 0% across all tested models |
| Chronological ordering (5 events) ^4^| ~50% | ~55% | ~48% | ~52% | ~45% | All degrade rapidly with list length |
| Hard temporal causal (TempoBench) | ~7.5% F1 | ~8.5% F1 | ~6% F1 | ~10% F1 | ~5% F1 | All below production-viable thresholds |
| TimeBench human gap ^2^| 19.4% | 22.1% | 24.3% | 18.7% | 26.8% | Consistent gap across architectures |

\* GPT-4.1 tested under explicit time-aware condition (8× improvement over control but still unreliable).

The consistency of these failure patterns across model families—transformers with different positional encodings (RoPE, absolute, relative), different training data mixes, and different scales—strongly suggests that the root cause is architectural rather than dataset-specific. This is further supported by the Toolformer paper's explicit identification of "unawareness of the progression of time" as an inherent limitation that cannot be fully addressed by further scaling ^12^.

### 1.3.2 Cross-Domain Manifestation

Temporal failures are not niche limitations restricted to calendar arithmetic. They manifest across at least six distinct application domains, each with distinct cost structures.

In **negotiations and strategic dialogues**, the UPenn study demonstrates that real-time deadlines reduce deal closure rates by an order of magnitude compared to turn-based equivalents ^1^. In **therapy sessions and clinical summarization**, TIMER-Bench reveals poor temporal boundary adherence, inaccurate trend analysis, and chronological confusion when reasoning over longitudinal Electronic Health Records ^17^. In **business planning and financial forecasting**, FinTradeBench shows that retrieval improves reasoning over textual fundamentals but provides limited benefit for trading-signal reasoning, highlighting fundamental challenges in numerical and time-series reasoning ^18^.

In **software project estimation**—the central concern of this compendium—the compound fracture of architectural limitation, human bias replication, and broken methodology produces systematically incorrect duration predictions. In **clinical and legal text processing**, temporal misalignment can cause models to reference outdated regulations, superseded precedents, or expired consent windows. The Air Canada chatbot case exemplifies the legal liability risk: a chatbot provided incorrect information about bereavement fare policies, and Air Canada was held liable because the chatbot represented a "negligent misrepresentation" even though the underlying policy had changed.

In **video understanding and multimodal applications**, the ReXTime benchmark demonstrates that models struggle when questions and answers occur in different video segments, requiring true cross-segment temporal reasoning ^8^. The TRAVELER benchmark extends this to implicit and vague temporal references, showing that shifting from explicit to vague references reduces model accuracy by 45% ^14^.

### 1.3.3 Production Impact

The production impact of temporal failures falls into three categories: deprecated recommendations, legal liability, and the silent tax of continuous staleness.

**Deprecated API recommendations** occur at rates between 25% and 38% in studies of coding agent outputs, depending on training data age and ecosystem velocity. In fast-moving domains (frontend frameworks, cloud APIs, ML libraries), this rate approaches the upper bound. The failure is often silent: the agent generates syntactically valid code against a deprecated API, and the error manifests only at runtime.

**Legal liability** has already been demonstrated in the Air Canada case and is anticipated in domains where temporal accuracy is regulated: financial advice, medical guidance, and legal assistance. Early precedent suggests that organizations deploying LLM agents may be held responsible for temporal inaccuracies even when the model was "correct" at its training cutoff.

**The silent tax of continuous staleness** is the most insidious impact. Unlike dramatic failures (4% deal closure is obviously broken), staleness degrades output quality gradually and invisibly. A coding agent that recommends `numpy` 1.24 instead of 1.26 produces code that works today but may miss security patches tomorrow. Tianpan.co (2026) documents this as "temporal decay"—the quiet degradation of AI features as model knowledge ages out between training cycles.

The aggregate economic impact is unmeasured but plausibly large. METR's evaluations show that "messiness" degrades AI performance by approximately 0.5% per factor per hour of task duration ^9^. With 16 identified messiness factors, a complex software task could experience 8% reliability degradation per hour. For a 4-hour task, this implies cumulative degradation that compounds nonlinearly across iterative cycles—precisely the pattern observed in agentic overconfidence studies.

The scope is therefore not a marginal edge case. Temporal failures affect every model family tested, every domain where time matters, and every production system where an LLM generates recommendations against a changing world. The next chapter turns to why these failures occur: the architectural and training-data mechanisms that make continuous time invisible to models built on discrete token prediction.


---

# 2. Root Causes: Why LLMs Cannot Tell Time

The previous chapter established that LLM time estimation failures are systematic, cross-architectural, and consequential. This chapter moves from phenomenology to etiology. The question is not *whether* models fail at temporal tasks but *why*—at the level of transformer mathematics, training data distributions, and cognitive emulation. The answer, revealed through the research literature, is not a single defect but a lattice of interlocking limitations. Understanding this lattice is prerequisite to any credible remediation strategy, because the fix for an architectural incapacity differs fundamentally from the fix for a data sparsity problem or a replicated human bias.

### 2.1 Architectural Limitations of Transformers

Contemporary LLMs are built on the transformer architecture introduced by Vaswani et al. in 2017. That architecture was designed for sequence-to-sequence modeling: machine translation, text completion, classification. It was not designed for real-time awareness, duration tracking, or continuous-time reasoning. The mismatch between what transformers do well and what time estimation requires is the primary cause of the failures documented in Chapter 1.

#### 2.1.1 Statelessness: No Persistent Hidden State

Unlike recurrent neural networks (RNNs) and Long Short-Term Memory networks (LSTMs), which maintain an explicit hidden state vector that evolves across time steps, transformers are mathematically stateless between forward passes ^10^. Each inference call begins from the same architectural condition; the only "memory" of prior interaction is the text that gets fed back into the context window ^5^. There is no internal register, accumulator, or counter that could serve as an elapsed-time clock. As one technical analysis puts it, "The transformer is mathematically stateless. Each forward pass is independent: feed it the same input, get the same output, always. No hidden state persists between function calls" ^5^.

This statelessness has a direct, testable consequence. During the standby interval between user messages, the model exists in what researchers term "temporal isolation"—it has no mechanism to track how many seconds, minutes, or hours have elapsed since the previous turn ^2^. An LSTM's hidden state would continue to evolve (or at least retain its last value) during such intervals; a transformer's "state" lives only in the growing sequence itself, meaning time tracking would require re-processing the entire context repeatedly to infer elapsed duration from textual cues alone. The implications are stark: even if a model were theoretically capable of inferring time from text, it would need the entire conversational history present in every forward pass, and even then it would be estimating from linguistic proxies rather than from an internal accumulator.

#### 2.1.2 Positional Encoding ≠ Time Encoding

Transformers process tokens in parallel, which means they have no inherent notion of sequence order. To inject positional information, architects add positional encodings—sinusoidal vectors in the original design, Rotary Position Embedding (RoPE) in LLaMA and Mistral, ALiBi in some variants. These encodings encode sequence position (token index), not real-world time ^19^. Two events separated by ten tokens receive the same positional encoding regardless of whether those ten tokens spanned one second or one hour.

A survey of positional encoding in time-series transformers confirms this explicitly: "standard positional encodings assume uniform time steps and do not capture the actual temporal distances between events" ^19^. The RoPE mechanism used in modern decoder-only LLMs ensures that attention calculations depend on relative token distances while maintaining absolute position information, but it has no access to wall-clock intervals ^19^. When a user types slowly for thirty seconds and produces three tokens, then pastes a block that generates three hundred tokens in under a second, the model sees a positional jump of 297 positions—not a time jump of less than one second. The positional encoding system is blind to the velocity of token arrival, and therefore blind to the real-world time that elapsed between tokens.

Domain-specific architectures such as ChronoFormer have demonstrated that explicit continuous-time encoding mechanisms are needed for temporal modeling, incorporating both absolute timestamp embeddings and relative time-delta embeddings through separate learnable modules ^20^. Standard LLMs lack these entirely.

#### 2.1.3 Self-Attention Theoretical Incapacity

The most rigorous explanation for why transformers cannot track time comes from computational theory. Hahn (TACL 2020) proved that self-attention—hard or soft, even with infinite precision—cannot model periodic finite-state languages or basic recursion ^4^. Specifically, "self-attention cannot in general emulate stacks or general finite-state automata" ^4^. Recurrent networks such as LSTMs, by contrast, "can perfectly emulate finite-state automata" and can predict parity of independent bit strings with perfect accuracy regardless of input length ^4^.

Time tracking is, at its core, a form of counting and accumulation: an elapsed-time counter increments at each tick, accumulating a running total. This is precisely the kind of periodic, stateful computation that Hahn proved self-attention cannot model asymptotically ^4^. The theorem does not merely suggest that transformers are bad at counting; it proves that the self-attention mechanism lacks the computational expressiveness to implement a simple accumulator. When an LLM is asked "how much time has passed since the meeting started?," the operation required—accumulating elapsed duration from a starting reference point—is computationally outside the class of functions that self-attention can represent.

#### 2.1.4 Attention Entropy and Working Memory Limits

Even within a single forward pass, attention mechanisms impose a second temporal constraint. Gong and Zhang (Yale, 2024) demonstrated that as the distance between related tokens increases, the total entropy of the attention score matrix increases, causing attention to disperse across more positions ^6^. This "dispersion of attention scores might be the cause of the capacity limit observed in N-back tasks" ^6^, where models must maintain focus on specific tokens across increasing sequence distances.

For temporal reasoning, this means that temporal markers—phrases like "started at 2:15" or "deadline in 30 minutes"—lose salience as the sequence grows. The attention mechanism, designed to relate all tokens to all other tokens, paradoxically dilutes specific relational signals as context length increases. Temporal information that needs to be maintained across a long document or conversation is subject to the same entropy-driven dispersal that limits working memory in N-back experiments. The farther a temporal reference is from the point where its value is needed, the more diffused its signal becomes in the attention matrix.

#### 2.1.5 Next-Token Prediction Compounding

The training objective of autoregressive LLMs is next-token prediction: given a prefix, maximize the likelihood of the correct subsequent token. Niu et al. (NeurIPS 2023) showed that this objective fundamentally reduces multi-step compositional reasoning into "linearized subgraph matching," where models "fundamentally rely on a greedy process, predicting the next word without a comprehensive global understanding of the task" ^9^. Under reasonable assumptions about task complexity, "the probability of incorrect predictions converges exponentially to approximately 1 for abstract compositional tasks" ^12^.

Temporal reasoning is inherently compositional. Computing the end time of a meeting that started at 14:15 and lasts 45 minutes requires: (1) parsing "14:15" into hour and minute components, (2) adding 45 to the minute component with carry-over logic, (3) formatting the result. Each step introduces error probability, and these errors compound multiplicatively. The TimeBench benchmark (ACL 2024) empirically confirms this: duration-conversion tasks, which require exactly this two-step unit-unification followed by numerical comparison, show accuracy drops to 25% for GPT-4 and 27% for LLaMA2-70B—compared to much higher performance on single-step atomic temporal tasks ^21^.

Even inference-time interventions such as Chain-of-Thought and Tree-of-Thought cannot fully overcome this bias. As a 2025 benchmark study found, "LLMs do not exhaustively search for all reasoning paths and remain biased toward certain ones. As inference-time compute scales, this bias persists, limiting exploration and leading to diminished performance" ^14^. The bias propagates through successive reasoning steps, producing cumulative errors that degrade temporal calculations at each compositional layer.

The architectural causes are not independent; they reinforce each other. Statelessness removes the possibility of an internal clock. Positional encoding removes the possibility of inferring time from token spacing. Self-attention's theoretical limits remove the possibility of counting or accumulation. Attention entropy removes the possibility of maintaining temporal focus across long contexts. Next-token prediction removes the possibility of reliable multi-step temporal computation. Table 1 summarizes these five interlocking causes, their mechanisms, and the empirical evidence supporting each.

**Table 1. Architectural Causes of LLM Time-Tracking Failure**

| Cause | Mechanism | Key Evidence | Quantitative Impact |
|-------|-----------|------------|---------------------|
| Statelessness | No persistent hidden state between forward passes; KV cache is not a time accumulator ^10^ ^5^| Hacker News technical analysis; Wolters architectural blog ^5^| 99% deal closure under turn limits vs. 4% under wall-clock time ^8^|
| Positional encoding ≠ time encoding | RoPE/sinusoidal encodings encode token index, not wall-clock interval ^19^| Positional encoding survey; ChronoFormer temporal embedding requirement ^20^| Identical encoding for 10 tokens spanning 1 s or 1 h ^19^|
| Self-attention theoretical incapacity | Cannot model periodic finite-state languages or counting (Hahn 2020) ^4^| TACL 2020 theoretical proof; parity and stack emulation impossibility ^4^| Asymptotic failure; LSTMs achieve perfect parity, transformers cannot ^4^|
| Attention entropy / working memory limits | Attention score entropy increases with token distance $N$ ^6^| Gong & Zhang 2024; N-back capacity experiments ^6^| Temporal marker salience decays as sequence length grows |
| Next-token prediction compounding | Compositional reasoning reduced to pattern matching; errors compound exponentially ^9^ ^12^| Niu et al. NeurIPS 2023; TimeBench duration-conversion tasks ^21^| GPT-4 drops to 25% on two-step duration conversion ^21^|

The table reveals a progression from the most fundamental (statelessness) to the most consequential (error compounding). Each lower layer constrains the layer above it. Because the architecture is stateless, positional encoding becomes the only temporal signal available—but positional encoding does not encode real time. Because self-attention cannot count, even a hypothetical time-encoded signal could not be accumulated. Because attention entropy disperses signals, any temporal information that is present becomes diluted. And because next-token prediction favors greedy pattern matching over systematic reasoning, the small errors introduced at each layer compound into catastrophic failures on multi-step temporal tasks. The University of Pennsylvania negotiation study provides the cleanest empirical distillation of this stack: when strategic dialogues are constrained by turn limits (a token-aligned representation), GPT-5.1 achieves 99% deal closure; when identical constraints are expressed in wall-clock seconds, closure drops to 4% ^8^. The only variable is the temporal representation; the strategic reasoning capability remains constant. This confirms that the failure is specifically in time tracking, not in reasoning generally.

### 2.2 Training Data and Representational Causes

Architectural limitations are necessary but not sufficient to explain the full scope of LLM temporal failures. Training data composition and representational artifacts introduce a second, independent layer of constraints. Even a hypothetical architecture capable of perfect temporal computation would struggle if its training data provided insufficient, fragmented, or biased temporal information.

#### 2.2.1 Date and Number Tokenization as Hidden Bottleneck

Before a date or number reaches the transformer layers, it passes through a tokenizer that segments text into subword units. This process, seemingly an implementation detail, creates a quantifiable bottleneck for temporal reasoning. A 2025 study on date tokenization introduced the "fragmentation ratio" metric—the proportion of a date string that gets split into semantically meaningless subword pieces—and demonstrated that "the more fragmented the tokenization, the worse the reasoning performance" ^22^.

The variation across model families is dramatic. OLMo achieves an average fragmentation ratio of 0.15 on date strings, while Llama 2 and Phi 3.5 reach 0.60 ^22^. A tokenizer that splits "2025-03-14" into fragments like "20", "25", "-0", "3", "-1", "4" not only inflates token count but "severs the natural boundaries of year, month, and day" ^22^. The study found a Pearson correlation of $-0.42$ between fragmentation ratio and accuracy across formats, and $-0.61$ across temporal splits ^22^.

Larger models partially compensate through an emergent ability the authors term "date abstraction"—stitching fragmented tokens back together at intermediate layers. Qwen2.5-0.5B reaches this compensation point at layer 12 (50% depth), while Qwen2.5-7B achieves it at layer 4 (14.3% depth) ^22^. But compensation is not elimination; the fragmented input still degrades accuracy relative to intact tokenization.

Number tokenization compounds the problem. Frontier models tokenize long numeric sequences in variable-length chunks (1-, 2-, or 3-digit groupings, left-to-right), which can split numbers at semantically incorrect boundaries ^23^ ^24^. The direction of tokenization (left-to-right versus right-to-left) creates systematic performance differences on arithmetic tasks ^23^. A study on multi-operand addition found that all investigated models, regardless of tokenization strategy, rely on a "one-digit lookahead heuristic" that forms an upper bound on arithmetic accuracy and fails when carry-over logic spans multiple operands ^25^. Because temporal computation is arithmetic-dependent (adding days to dates, computing durations across month boundaries), these tokenization-induced arithmetic limits propagate directly into temporal reasoning failures ^11^.

#### 2.2.2 Temporal Distribution in Training Corpora

The pretraining data for modern LLMs is dominated by web-crawled text, with CommonCrawl supplying approximately 80–85% of GPT-3's training tokens ^26^. CommonCrawl spans monthly snapshots from 2008/2009 to the present, but temporal distribution within each snapshot is highly non-uniform ^26^. Web content exhibits a severe recency bias: recent years are massively overrepresented compared to historical periods, and even within recent periods, temporal sequences (explicit dates, durations, event timelines) constitute a tiny fraction of total text.

A 2025 study on time-series-augmented LLMs noted that "less than 0.1% of web-scraped text corpora contain meaningful temporal sequences" ^27^. This is not merely a quantity issue; it is a representation issue. When fewer than one in a thousand training examples contain structured temporal information, models have minimal opportunity to learn the patterns of duration, elapsed time, and deadline management that humans absorb from schedules, calendars, and time-sensitive communications.

Knowledge cutoffs add another layer of temporal distortion. Rather than a single clean boundary, models exhibit "soft" or uneven cutoffs due to old data in new CommonCrawl dumps and complications in deduplication schemes ^28^. Changepoint analysis on Claude Sonnet 4 identified two distinct knowledge boundaries at February 2023 and December 2024, producing mean faithfulness scores of 1.25, 0.93, and 0.05 across the three segments, with refusal rates climbing from 28.7% to 95.1% ^29^. This means the model's temporal knowledge is not uniformly distributed even within its claimed training window—some periods are well-represented, others are effectively absent.

#### 2.2.3 Long-Tail Historical Sparsity and Catastrophic Forgetting

Historical knowledge follows the same long-tailed distribution as other factual domains, but with a temporal twist: the farther back in time an event lies, the sparser its representation in web-scale corpora. The Ticktack framework addressed this by re-embedding historical years using the sexagenary (60-year cycle) calendar, which compresses thousands of years into a uniformly distributed 60-category space, achieving a 34% accuracy improvement on long-span questions ^30^. The need for such exotic re-encodings underscores the severity of the sparsity problem in standard Gregorian representations.

Historical documents specifically exemplify long-tail knowledge challenges. The KE-MHISTO benchmark found that "information about historical entities and events is sparse in the pre-training datasets," and while larger models improve on frequent knowledge, they "provide only modest benefits for infrequent knowledge" ^31^. Even structured temporal knowledge graphs exhibit long-tailed relation distributions, with a few relations (e.g., startMemberOf) dominating while most appear rarely, and the peak of temporal facts occurring in 2013 with approximately 100,000 facts, steadily decreasing afterward ^32^.

Continual learning does not reliably solve this. A study on catastrophic forgetting in LLMs from 1B to 7B parameters found that "as the model scale increases, the severity of forgetting intensifies" in this range ^33^. The TiC-LM benchmark, using 114 months of CommonCrawl data (2.9T tokens), showed that continual pretraining with replay can match periodic retraining with 62% less compute, but that replay can actually hurt on rapidly evolving domains like StackOverflow ^34^. For temporal knowledge, this means there is no universal strategy: maintaining historical facts requires replay of old data, but doing so may degrade performance on contemporary temporal references.

#### 2.2.4 Temporal Representation in Embeddings

Despite these limitations, LLMs do encode some temporal information internally. Gurnee and Tegmark (MIT) discovered that LLMs learn linear representations of space and time, with individual "time neurons" that reliably encode temporal coordinates ^35^. These representations are linear (nonlinear probes do not outperform linear ones), robust to prompting variations, and unified across different entity types ^35^. Probing experiments reveal that models build spatial and temporal representations throughout early layers, plateauing around the halfway point, with larger models consistently outperforming smaller ones ^35^.

However, linear decodability does not imply functional availability. The representations could be epiphenomenal—byproducts of training on dated text rather than causal features used during inference. Gurnee and Tegmark acknowledge this explicitly: high predictive performance on out-of-sample data "does not imply that the model actually uses these representations" ^35^. Even if the representations are causally active, they appear to encode static temporal coordinates (years, dates) rather than dynamic duration or elapsed-time concepts.

Training data composition also creates representational bias. A 2026 cross-calendar study found that all tested LLMs perform significantly better on Gregorian-to-Other calendar conversions than on Other-to-Gregorian conversions, with accuracy gains ranging from 3.97% to 17.49% for the Gregorian-origin direction ^36^. The authors term this "Calendar Asymmetry Bias" and attribute it to the prevalence of Gregorian-origin expressions in pretraining data ^36^. Models also perform better on festival-based temporal reasoning because festival dates are more common in training corpora ^36^. These biases are not random noise; they are systematic distortions induced by the cultural and temporal composition of web-scale text.

**Table 2. Training Data and Representational Factors in LLM Temporal Failure**

| Factor | Mechanism | Quantitative Evidence | Affected Temporal Capability |
|--------|-----------|----------------------|---------------------------|
| Date tokenization fragmentation | Subword tokenizers split dates into semantically meaningless pieces ^22^| Fragmentation ratios 0.15–0.60 across models; correlation with accuracy $r = -0.42$ to $-0.61$ ^22^| Date parsing, comparison, duration computation |
| Number tokenization strategy | Variable-length chunking (1–3 digits) splits at semantically incorrect boundaries ^23^ ^24^| Left-to-right vs. right-to-left tokenization produces stereotyped error patterns ^23^| Arithmetic for temporal calculations |
| Temporal sequence scarcity | <0.1% of web text contains meaningful temporal sequences ^27^| TsLLM finding; 25B synthetic tokens needed to compensate ^27^| Duration estimation, deadline tracking |
| Non-uniform knowledge cutoffs | Old data in new crawls + deduplication artifacts create soft boundaries ^28^| Claude Sonnet 4: two changepoints, faithfulness 1.25→0.05, refusals 28.7%→95.1% ^29^| Temporal fact retrieval, recency-dependent reasoning |
| Long-tail historical sparsity | Historical events exponentially rarer in web corpora ^31^| KE-MHISTO: modest scale benefits for infrequent knowledge ^31^; Ticktack +34% with sexagenary re-encoding ^30^| Long-span historical dating |
| Catastrophic forgetting | Temporal fine-tuning distorts existing knowledge ^37^ ^33^| 1B–7B range: forgetting intensifies with scale ^33^; yearwise fine-tuning drops correct answers from 22% to 18% ^37^| Temporal knowledge stability |
| Calendar asymmetry bias | Gregorian-dominant training data biases cross-calendar reasoning ^36^| 3.97%–17.49% accuracy gap (Gregorian→Other vs. reverse) ^36^| Cross-calendar conversion |

The table presents seven distinct training-data factors, each affecting a different temporal capability. The fragmentation and number-tokenization issues operate at the input layer, degrading the model's ability to even represent temporal quantities correctly. The scarcity and cutoff issues operate at the knowledge layer, limiting what temporal patterns the model has learned. The sparsity and forgetting issues operate at the retention layer, causing learned temporal knowledge to decay or distort. And the calendar bias operates at the representational layer, skewing the model's internal temporal coordinate system toward the Gregorian calendar. Together, these factors mean that even if the architectural limitations of Section 2.1 were somehow overcome, the model would still lack reliable temporal knowledge and would process what knowledge it has through fragmented, biased representations.

### 2.3 The Compound Fracture in Software Engineering Contexts

The preceding sections identified two independent root-cause layers: architectural incapacity and training-data deficiency. In software engineering time estimation, a third layer compounds these: the breakdown of traditional estimation methodologies when applied to LLM-assisted development. The result is what this chapter terms a "compound fracture"—three simultaneous, mutually reinforcing causes of estimation failure.

#### 2.3.1 Three Simultaneous Compounding Causes

When a coding agent provides an incorrect time estimate, the failure emerges from the intersection of:

1. **Architectural time-tracking failure**: The LLM cannot internally track elapsed wall-clock time, cannot accumulate duration, and cannot maintain temporal focus across long contexts (Section 2.1). The model processes the estimation request as a pattern-matching exercise on training examples, not as a computational projection from known parameters.

2. **Replicated human planning fallacy and optimism bias**: LLMs trained on human-generated text inherit the distributional patterns of human temporal estimation, which are systematically optimistic. Kahneman and Tversky's planning fallacy—the "hardwired tendency to imagine the best-case path to completion and treat it as a prediction" ^38^—is replicated in model outputs because the training data is dominated by human estimates that themselves exhibit this bias. Hofstadter's Law ("It always takes longer than you expect, even when you take into account Hofstadter's Law") ^39^is not a pattern that appears explicitly in training data; the data instead contains the un-corrected optimistic estimates that the law describes.

3. **Broken traditional estimation methodologies**: COCOMO (Constructive Cost Model), Function Points, and Story Points were designed for human labor executing well-defined tasks. They assume human execution speed, cognitive constraints, and communication overhead. When an LLM assists or replaces portions of this labor, the fundamental cost drivers change—but the estimation models do not account for this transition.

These three causes do not merely add; they multiply. An architectural inability to perform temporal arithmetic (cause 1) means the model cannot correct the optimistic bias it has learned from human data (cause 2). The optimistic bias means the model produces estimates that align with traditional methodologies (cause 3) only because those methodologies themselves are built on human optimism. The result is a coherent-seeming but systematically wrong estimate: the model appears to be doing estimation, but it is actually performing a three-layer pattern match that reproduces the biases of all three source systems.

**Figure 1. The Compound Fracture: Three-Layer Model of LLM Estimation Failure**

The diagram depicts a three-tier causal cascade. At the bottom tier, labeled "Architectural Substrate," a decoder-only transformer block is shown with arrows indicating its five structural limitations: statelessness (no persistent register), positional encoding blindness to wall-clock time, self-attention's theoretical inability to count or accumulate, attention entropy that disperses temporal markers as sequences lengthen, and next-token prediction that reduces multi-step reasoning to greedy pattern matching. A vertical arrow rises from this tier to the middle tier, labeled "Cognitive / Data Layer," where two feedback loops operate: a "Planning Fallacy Loop" (the model replicating human optimism bias from training data) and a "Temporal Knowledge Decay Loop" (fragmented tokenization, long-tail sparsity, and catastrophic forgetting eroding the data foundation). A second vertical arrow rises to the top tier, labeled "Estimation Methodology Layer," where traditional models (COCOMO, Function Points, Story Points) are shown as boxes with dashed borders—indicating they are unparameterized for LLM-specific cost drivers. A final arrow descends from the top tier back to the bottom, labeled "Compounding Feedback," indicating that incorrect estimates generated at the methodology layer are fed back into training data (via RLHF, synthetic data generation, and user interactions), reinforcing the same patterns in future model versions. The output at the top right is labeled "Systematically Incorrect Estimate," with three contributor weights: architectural (40%), cognitive/data (35%), and methodological (25%). These weights are approximate, derived from the relative severity of each cause class as documented in the empirical literature.

The diagram illustrates why fixing any single layer is insufficient. An external tool that provides the LLM with a real-time clock (addressing the architectural layer) does not remove the optimism bias the model applies to the clock's reading, nor does it update the parametric estimation model to account for LLM inference time. Conversely, a better estimation methodology cannot overcome the model's inability to perform the arithmetic that methodology requires. The three layers must be addressed simultaneously, a requirement that shapes the design criteria for any comprehensive time estimation tool.

#### 2.3.2 Why Traditional Models Fail

COCOMO, Function Points, and Story Points share a common assumption: the work is performed by human engineers at human speed. COCOMO II's cost drivers include analyst capability, programmer capability, application experience, and platform experience—all human attributes ^40^. Function Points measure user-visible functionality and assume human implementation effort per function point. Story Points estimate relative human effort within a team's historical velocity.

A 2026 conceptual framework for "LLM-aware software effort estimation" identified five LLM-specific cost drivers that are entirely unparameterized in traditional models: reasoning complexity (the depth of multi-step reasoning the LLM must perform), context completeness (whether the model has sufficient context to generate correct code without ambiguity), transformation impact (the scope of code changes required), iterative cycles (the number of generate-test-revise loops), and human oversight (the degree of human review and validation still required) ^40^. When an LLM generates code, the dominant cost may be prompt engineering and validation time, not coding time. When an LLM requires three iterative cycles to produce correct output, the wall-clock duration is determined by API latency and human review speed, not by the nominal complexity of the function being implemented.

Flyvbjerg's reference class forecasting provides a benchmark for how wrong traditional estimates can be. Cost estimates for large projects between 1910 and 1998 were 28% short of final cost on average, with IT projects among the most prone to overruns because "each project is sufficiently dissimilar to previous projects" ^41^. At early project stages, reference class forecasting suggests schedule uplifts of +75% to achieve 80% confidence ^40^. LLM-assisted development is, by this standard, still at the earliest possible stage: the "reference class" of LLM-assisted projects is tiny, and each project deploys different models, tools, and integration patterns. The dissimilarity that makes human IT estimates unreliable makes LLM-assisted estimates even more so.

#### 2.3.3 The Token-Time Mapping Problem

A specific manifestation of the compound fracture is the token-time mapping problem. LLM agents currently operate within token budgets—typically 200K to 500K tokens per session—not time budgets. Agents estimate tasks in "steps," "iterations," or "turns," which are token-aligned units, and then attempt to translate these into wall-clock minutes for human consumption. This translation is broken for three reasons.

First, tokens do not linearly correlate with wall-clock time. A single reasoning step that invokes a code interpreter may consume 50 tokens of output but require 30 seconds of execution. A turn that calls an external API may consume 200 tokens but require 5 seconds of network latency. The model's token budget provides no information about these latency multipliers.

Second, the model's own generation speed varies. Token throughput depends on model size, quantization, hardware, and concurrent load. The model has no access to its own tokens-per-second rate during inference, and therefore cannot convert its internal step count to an elapsed-time estimate.

Third, parallel execution is invisible to the token counter. When an agent spawns multiple tool calls simultaneously, wall-clock time is determined by the slowest call, not by the sum of tokens consumed. The token budget sees only the total tokens, not the critical-path duration.

The result is that when an agent says "I'll complete this in a few steps" or "this should take about 10 minutes," the estimate is derived from a token-aligned intuition that has never been calibrated against wall-clock measurement. The agent is reasoning in token-space and speaking in time-space, with no reliable mapping between the two coordinate systems. This is not merely an estimation error; it is a dimensional mismatch that no amount of prompting or fine-tuning can resolve without an external time-measurement mechanism.

The compound fracture thesis reframes the user's original complaint—"every time I get an estimate from a coding agent, it's wrong"—from a quality issue to a structural inevitability. Given an architecture that cannot track time, trained on data that replicates human optimism, generating outputs through methodologies designed for human labor, and reasoning in token units that map nonlinearly to wall-clock duration, accurate estimation would be the surprising outcome. The remainder of this report examines what interventions can address each layer of this fracture, starting with the software engineering estimation problem specifically.


---

# 3. The Software Engineering Dimension

Software effort estimation has occupied researchers and practitioners for more than half a century. From the U.S. Navy's Polaris missile program to modern agile teams, the discipline evolved through algorithmic models, functional sizing techniques, relative consensus methods, and statistical simulations. Every one of these traditions shares a foundational assumption that is now being dismantled: **human labor is the primary cost driver**, and effort can be approximated through proxies such as code size, functional complexity, or perceived task difficulty. The emergence of LLM coding agents does not merely challenge this assumption at the margins—it collapses the very proxies on which the entire field was built.

## 3.1 Traditional Software Estimation Methods

### 3.1.1 Algorithmic Models: COCOMO II

Barry Boehm's Constructive Cost Model (COCOMO), introduced in 1981, derived its parameters from empirical data across 63 software projects. Its basic formulation, $E = a \times (\text{KLOC})^b$, treated thousands of lines of code (KLOC) as the principal size proxy and produced estimates for effort in person-months and duration in calendar months ^2^. The organic-project variant, $E = 2.4 \times (\text{KLOC})^{1.05}$, embeds a human-labor assumption so deeply that the model cannot be separated from it: the exponent reflects the sub-linear scaling of human teams, and the coefficient reflects historical staffing patterns.

COCOMO II (2000) extended the model to object-oriented development, component reuse, and iterative life cycles, incorporating 17 cost drivers and five scale factors ^1^. Yet the model was explicitly not designed for agile methodologies, let alone for AI-augmented development in which a single prompt can generate the equivalent of hundreds of lines of code in seconds ^1^. The Post-Architecture Model still requires KSLOC or function points as its primary input—quantities that have lost their predictive power when the generating entity is not a human programmer but a statistical model operating at inference time.

### 3.1.2 Functional Sizing: Function Point Analysis

Allan Albrecht's Function Point Analysis (FPA), developed at IBM in 1979 and later ISO-standardized (ISO/IEC 20926), measures business functionality delivered to users through five types: outputs, inquiries, inputs, internal files, and external interfaces ^8^. The method was revolutionary because it decoupled size estimation from implementation technology—two systems with identical function points could be built in different languages on different platforms and still carry the same functional-size score.

Yet FPA is structurally unable to represent the forces that dominate LLM-assisted development. It offers no mechanism to capture dependency networks, platform migration risk, or the volatility of continuously evolving systems ^3^. A one-line change in a critical dependency can cascade through hundreds of files, but FPA records only the functional delta. Its static snapshots become obsolete almost immediately in a codebase that an LLM agent is continuously refactoring.

### 3.1.3 Agile Estimation: Story Points and Planning Poker

Story Points use the Fibonacci sequence (1, 2, 3, 5, 8, 13, 20, 40, 100) as a relative measure of perceived difficulty, uncertainty, and risk ^6^. The widening gaps between successive numbers encode the intuition that humans can distinguish 1 kg from 2 kg far more reliably than 20 kg from 21 kg ^6^. Planning Poker, refined by James Grenning (2002) and popularized by Mike Cohn (2005), adds a consensus mechanism based on the RAND Corporation's Wideband Delphi method: estimators privately select cards, reveal simultaneously to avoid anchoring bias, and iterate until convergence ^4^.

The method works when the dominant cost drivers are human cognitive complexity, coordination overhead, and domain uncertainty. It fails when a significant fraction of the work is performed by an LLM, because the Fibonacci scale was never calibrated for prompt-engineering complexity, hallucination recovery, or integration-test failure cascades. As tasks of identical Story Point size begin to exhibit wildly different actual effort profiles—some completing in minutes via a well-scoped prompt, others consuming hours in validation cycles—the consensus mechanism loses its stabilizing property.

### 3.1.4 Statistical Approaches: PERT and Evidence-Based Scheduling

The Program Evaluation and Review Technique (PERT), developed by the U.S. Navy in the 1950s, requires three time estimates per task—optimistic ($O$), most likely ($M$), and pessimistic ($P$)—and computes expected time as $T_E = (O + 4M + P) / 6$ ^10^. Network diagrams then identify critical paths and slack, producing probabilistic schedules that explicitly account for uncertainty.

Joel Spolsky's Evidence-Based Scheduling (EBS), created at Fog Creek Software in 2007, tracks individual developers' estimate-versus-actual histories and feeds those distributions into Monte Carlo simulations ^5^. EBS rests on a critical insight: developers are often *consistently* wrong (for example, perpetually underestimating by a factor of 0.6), but their *relative* ordering of tasks by difficulty is usually correct ^5^. The system therefore learns a personal velocity curve per developer.

Both PERT and EBS assume that execution time follows a distribution anchored to human performance. When an LLM generates code in seconds, the optimistic estimate collapses toward zero, the most-likely estimate becomes dominated by validation overhead, and the pessimistic estimate explodes due to hallucination-recovery cycles that no historical human velocity curve can predict. The Monte Carlo engine still runs, but the input distributions no longer describe the operative process.

| Method | Era | Primary Input Proxy | Output Unit | Core Assumption | Why It Breaks Under LLM Assistance |
|:---|:---|:---|:---|:---|:---|
| COCOMO / COCOMO II | 1981 / 2000 | KLOC, KSLOC, Function Points | Person-months, calendar months | Effort scales with human team size and code volume | LLMs generate KLOC-scale code in seconds; human labor is no longer the cost driver ^2^ ^1^|
| Function Point Analysis | 1979 | Inputs, outputs, inquiries, files, interfaces | Function Points (ISO 20926) | Functional size predicts effort regardless of technology | Cannot capture dependency networks, change risk, or continuous LLM-driven evolution ^8^ ^3^|
| Story Points / Planning Poker | 2002–2005 | Team consensus on relative difficulty | Unitless Fibonacci points | Human-perceived complexity correlates with actual effort | Insensitive to prompt complexity, validation overhead, and LLM-specific cost drivers ^6^ ^4^|
| PERT | 1958 | Three time estimates ($O$, $M$, $P$) per task | Expected time, critical path | Human execution time follows estimable distributions | Optimistic estimate collapses to near-zero; pessimistic dominated by hallucination recovery ^10^|
| Evidence-Based Scheduling | 2007 | Individual estimate-actual history | Monte Carlo probability distribution | Personal velocity curves are stable over time | No historical LLM-human hybrid velocity data exists; distributions are non-stationary ^5^|

The table reveals a systematic pattern: every traditional method uses a proxy that assumes human cognitive and manual labor as the rate-limiting step. COCOMO uses lines of code because humans type them slowly. Function Points measure functionality because humans implement it incrementally. Story Points capture relative difficulty because humans struggle to estimate absolutely. PERT and EBS model time distributions because human performance is stochastic but bounded. When an LLM can produce syntactically valid code at machine speed, all of these proxies become decoupled from actual effort. The effort does not disappear—it migrates to activities the traditional methods were never designed to measure: prompt engineering, context provision, iterative validation, hallucination mitigation, and integration reconciliation.

## 3.2 LLM-Assisted Development Changes Everything

### 3.2.1 Collapse of Size-Based Proxies

The most immediate disruption is the disintegration of size-based estimation. In COCOMO's world, more code means more time because humans read, type, and debug at roughly fixed speeds. In an LLM-assisted workflow, a developer can prompt an agent to "refactor the authentication module across 47 files" and receive a multi-file diff in under a minute. The size of the change set no longer correlates with human typing effort; it correlates with prompt specificity, context window capacity, and the agent's ability to resolve cross-file dependencies without hallucinating interface changes.

Research on ML-based effort estimation has shown that ensemble techniques consistently outperform solo methods, with artificial neural networks demonstrating superior performance on traditional datasets ^9^ ^12^. Yet these models were trained on historical projects in which code size and human effort were genuinely coupled. A 2025 Springer survey confirms that "fine-tuning models, optimizing parameters, utilizing datasets with effective feature selection, and employing appropriate model selection strategies are critical factors" for traditional estimation ^12^. None of these address the structural decoupling introduced by LLM assistance. The feature space has changed: the relevant inputs are no longer SLOC or function-point counts but prompt-complexity scores, context-completeness ratios, and iteration-depth forecasts.

### 3.2.2 Instability of Story Points in LLM Workflows

The Frontiers in Artificial Intelligence framework for LLM-aware software effort estimation identifies a specific mechanism by which Story Points fail: they are insensitive to LLM-specific cost drivers ^42^ ^13^. Two tasks assigned identical Story Points—say, a 5-point "add input validation" and a 5-point "update API response format"—may exhibit markedly different effort profiles when executed with LLM assistance. The first might require a single, well-scoped prompt and thirty seconds of generation. The second might involve five rounds of corrective prompting because the agent misinterprets the API contract, generates deprecated field names, or produces code that passes unit tests but fails integration validation.

This instability is not a calibration problem that can be fixed by recalibrating velocity. It is structural: "no amount of recalibration can fix Story Points without redefining what they measure" ^13^. The consensus mechanism of Planning Poker also degrades, because team members no longer share a common mental model of how an LLM will behave on a given task. One developer may anticipate a single prompt; another, having been burned by a similar task that required twelve validation cycles, will estimate an order of magnitude higher. The private-card reveal, designed to surface genuine disagreement, instead surfaces incompatible mental models of agent behavior.

### 3.2.3 The New Effort Distribution

The most significant shift is not that effort disappears—it is that effort redistributes. The Frontiers framework reconceptualizes effort as *Hybrid Intelligence Effort*, emerging from the interaction between LLM cognitive complexity and human oversight effort ^42^ ^21^. Five dimensions govern this new effort distribution, each absent from conventional estimation theory.

| Dimension | Definition | Operational Indicator | Why Traditional Models Miss It |
|:---|:---|:---|:---|
| LLM Reasoning Complexity | Depth of logical or architectural reasoning the LLM must perform | Number of prompt-revision rounds; presence of multi-step planning | COCOMO assumes coding is manual; complexity is measured in human cognitive load, not model reasoning depth ^21^|
| Context and Information Completeness | Degree to which necessary codebase context fits within the model's context window | Count of context-supplementing prompts; cross-file dependency coverage | FPA treats functionality as self-contained; it does not model context-window fragmentation ^21^|
| Code Transformation Impact | Scope of structural change across the codebase | Number of affected source artifacts; depth of dependency tree traversal | Size-based models assume linear effort per line; they do not capture nonlinear cascade effects ^21^|
| Iterative Reasoning Cycles | Number of correction, refinement, and validation loops | Prompt-response round count; corrective prompting frequency | PERT assumes bounded uncertainty; it cannot model unbounded iteration on hallucination recovery ^21^|
| Human Oversight Effort | Active human supervision, review, and intervention required | Validation findings count; manual intervention frequency | EBS learns human velocity, not human-supervision intensity over an autonomous agent ^21^|

The framework makes explicit what practitioners already observe: the bulk of effort in LLM-assisted development is no longer in manual construction but in managing the LLM's reasoning behavior, providing contextual information, conducting review cycles, and mitigating hallucinations ^42^. A task that would have taken a human engineer two hours of typing now takes five minutes of prompt crafting, thirty seconds of generation, and ninety minutes of validation—during which the agent may have introduced subtle bugs that pass unit tests but fail in staging. The total elapsed time is comparable, but its composition is inverted, and the phases that now dominate are invisible to every traditional estimation model.

## 3.3 What Current Coding Agents Actually Do

### 3.3.1 Token Budgets, Not Time Budgets

No major coding agent currently on the market—Claude Code, Cursor, GitHub Copilot, Devin, OpenAI Codex, or Windsurf—provides wall-clock time estimates before task execution ^43^. The practical heuristic offered by one comparison guide is instructive: "for tasks that take less than 5 minutes, use the IDE tool; for tasks you estimate will take more than 30 minutes, consider Claude Code" ^43^. Note the subject of the verb: *you* estimate. The human estimates; the agent does not.

Instead, agents operate on token budgets and session timeouts. A typical session runs within a 200K–500K token window; large codebases may consume 500K–1M tokens ^44^. A runaway loop—an agent iterating incorrectly on a hallucinated problem for 100 rounds at 80K context per iteration—can cost approximately \$24 with GPT-4o and \$240 or more with Claude Opus ^44^. These budgets are cost-control mechanisms, not time-prediction mechanisms. Gateway-level enforcement is recommended because "buggy agent code can skip its own budget check" ^44^, underscoring that the agent itself does not reason about its resource consumption in any meaningful way.

The absence of time estimation is not a missing feature that could be added in a future release. It is a consequence of the architectural time-tracking failures documented in Chapter 2: the agent has no internal representation of elapsed wall-clock duration and therefore cannot map its token-aligned reasoning steps to minutes or hours. When an agent says "I'll complete this in a few steps," it is reasoning in tokens and iterations, not in temporal units. The token-to-time mapping is fundamentally broken because it depends on API latency, reasoning depth per step, tool-call overhead, and the unpredictable duration of human oversight cycles—none of which are available to the agent at estimation time.

### 3.3.2 METR Time Horizons as Empirical Measurement

The Model Evaluation and Threat Research (METR) organization has developed the closest empirical equivalent to measuring agent capability over time: the *task-completion time horizon*, defined as the duration of tasks that models can complete at a given success probability. From 2019 to 2025, the 50-percent-success time horizon doubled approximately every seven months ^16^. GPT-2 managed two-second tasks; Claude 3.7 Sonnet reached fifty minutes; OpenAI's o3 approached two hours ^16^. METR's January 2026 Time Horizon 1.1 update found that Claude Opus 4.5 reaches approximately 320 minutes (5.3 hours) and GPT-5 reaches approximately 214 minutes (3.6 hours), with the doubling time accelerating to roughly 89 days ^17^.

These figures are empirically rigorous but measure completion time, not estimation accuracy. METR does not ask the model "how long will this take?" and then compare prediction to outcome. It asks "can you complete this task?" and records the duration of successful attempts. The distinction is critical for tool design: a system that measures how long a task took is not the same as a system that predicts how long a task will take with calibrated confidence intervals. Coding agents need the latter; the METR methodology provides only the former.

Furthermore, METR's tasks are deliberately cleaner than real-world software work. The organization defined sixteen "messiness" factors—including irreversible mistakes, limited consumable resources, unclear success criteria, real-time coordination needs, and novel situations—and found that each additional messiness point reduces mean success rates by roughly 8.1 percent ^18^. The mean messiness score across benchmark tasks is 3.2 out of 16, with no task exceeding 8. Real-world activities such as "writing a good research paper" would score between 9 and 15 ^18^. This means the time horizons, impressive as they are, describe performance on tasks that are substantially neater than the work that professional software engineers actually perform.

### 3.3.3 Case Study: Devin AI

Devin, marketed by Cognition AI as "the world's first AI software engineer" at a price point of \$500 per month, provides the most publicly documented case of an LLM coding agent failing to deliver within any reasonable time expectation. In an independent evaluation conducted by researchers at Answer.AI, Devin was given twenty representative coding tasks. It completed three ^19^.

The quantitative asymmetry is stark. On one task, researcher Carl Brown completed the work manually in thirty-six minutes; Devin spent six hours and ultimately failed ^19^. That is not a ten-percent overrun or a mis-scoped Story Point. That is a ten-fold time expenditure with zero deliverable output. Cognition AI's own guidance tacitly acknowledges these limitations: users are advised to "give Devin tasks that you know how to do yourself" and to restrict assignments to "tasks that will take less than three hours" ^19^. The most successful tasks were "glue code"—integration wiring that is repetitive, well-specified, and bounded.

Several factors explain why Devin's time performance diverged so dramatically from human baselines. First, agentic overconfidence: frontier LLM-based coding agents predict their own success at rates far exceeding their actual performance. GPT-5.2-Codex post-execution agents predicted 73 percent success against a true rate of 35 percent on SWE-bench Pro; Gemini-3-Pro predicted 77 percent against 22 percent; Claude Opus 4.5 predicted 61 percent against 27 percent ^20^. Agents are 5.5 times more likely to confidently predict success on a failing task than to doubt a successful one ^20^. This overconfidence directly inflates time expenditure: an agent that believes it is on the right path will continue iterating on a flawed approach rather than signaling failure or requesting clarification.

Second, execution hallucinations compound across iterations. LLM-based agents claim completion of sub-stages that were not actually performed, select non-existent tools, and fill tool-call parameters incorrectly ^45^. Each error biases subsequent cycles, and the bias accumulates "across steps, becoming increasingly difficult to detect or correct" ^45^. When an agent hallucinates that a dependency has been installed, it will spend subsequent hours debugging failures that stem from the hallucinated state rather than from genuine defects.

Third, Devin had no mechanism to estimate task duration before beginning. It operated until stopped, until a token limit was reached, or until the task appeared complete by its own flawed assessment. The six-hour failure was not a case of missing a deadline that Devin had set for itself; it was a case of unbounded execution on a task that exceeded the agent's actual capability, with no internal alarm to trigger early termination or human escalation.

The Devin case is not merely a product failure; it is a methodological signal. It demonstrates that the gap between LLM agent capability and reliable software engineering execution is not measured in incremental efficiency gains but in orders-of-magnitude differences in time expenditure and success probability. Estimation accuracy was never evaluated as a variable of interest. The Answer.AI researchers measured completion and duration; they did not report whether Devin predicted its own completion time or success probability, because the agent does not generate such predictions. The absence of estimation is itself the finding.

The implications extend beyond Devin to the broader ecosystem. Anthropic's internal study reports that engineers use Claude in approximately 60 percent of their work and self-report 50 percent productivity gains ^46^. Yet 27 percent of Claude-assisted work consists of tasks that "wouldn't have been done otherwise"—exploratory work and nice-to-have tools that would not be cost-effective if done manually ^46^. This suggests that some measured "productivity" is actually task expansion rather than acceleration. Meanwhile, a randomized controlled trial by METR found that AI tools *increased* task completion time by 19 percent among experienced developers on highly familiar codebases ^47^. The productivity effect is heterogeneous: novices gain more, experts may lose, and the direction depends on task familiarity and whether output quality is measured alongside speed.

Taken together, the evidence from traditional estimation theory, LLM-aware effort frameworks, METR time horizons, and the Devin case study converges on a single conclusion: software engineering is operating without a viable estimation paradigm for LLM-assisted work. The old models were built for human labor and cannot be incrementally patched. The new models are conceptual, not operationalized. The agents themselves do not estimate. And the empirical measurements that do exist describe what agents *can* do and *have* done, not what they *predict* they will do. Until that predictive layer exists, every schedule, sprint plan, and project commitment built around LLM assistance rests on uncalibrated optimism.                                                    

---

# 4. Current Fixes, Ongoing Research, and Future Directions

The evidence presented in preceding chapters establishes that LLM time estimation failures are not transient bugs but structural consequences of transformer architecture, training data properties, and the absence of estimation tooling. This chapter catalogs the full landscape of current mitigations, from production-ready tool-based approaches to experimental architectural modifications, and maps the research frontier that will determine whether those failures are temporary or permanent. The coverage is organized into four strata: external delegation (tools and protocols), prompt-level interventions, architectural and training-based approaches, and the emerging research agenda.

---

## 4.1 Tool-Based and External Delegation Approaches

The most reliable class of fixes does not attempt to improve the LLM's internal representation of time; instead, it externalizes temporal computation to deterministic systems and feeds the results back into the model's context window. This delegation pattern has been validated across multiple independent implementations.

### 4.1.1 Toolformer: Self-Supervised Tool Learning

Toolformer (Meta AI, NeurIPS 2023) demonstrated that a 6.7-billion-parameter GPT-J model can teach itself to invoke external APIs—including a calendar and a calculator—through self-supervised training that filters API calls by whether they reduce perplexity on surrounding tokens ^7^. The calendar tool specifically addresses what the authors identify as one of several inherent limitations of language models: "an unawareness of the progression of time" ^48^. When the model encounters a query requiring date arithmetic (e.g., "How many days ago was August 14, 2020?"), it learns to emit a calendar API call, receive the current date, and incorporate that signal into subsequent token prediction. The DATESET evaluation dataset showed that Toolformer's calendar and calculator tools significantly outperform the base model on temporal benchmarks without sacrificing core language modeling performance. The key insight is that the LLM does not learn to track time internally; it learns *when* to ask an external system for time information.

### 4.1.2 The MCP Ecosystem: Universal Integration

The Model Context Protocol (MCP) has become the dominant standard for LLM tool integration. As of March 2026, MCP recorded 97 million monthly SDK downloads across its Python and TypeScript implementations, with more than 10,000 active public servers covering developer tools, business applications, databases, search, and AI automation categories ^49^. In December 2025, Anthropic donated MCP governance to the Agentic AI Foundation under the Linux Foundation, with co-founding support from OpenAI, Block, Google, Microsoft, AWS, Cloudflare, and Bloomberg ^49^. The protocol is now natively supported across Claude Code, Cursor, VS Code, Windsurf, ChatGPT, Gemini, and Microsoft Copilot, making it the de facto universal integration layer for AI tool use ^50^.

Within this ecosystem, dedicated time servers exist: `mcp-server-time` provides current time and timezone conversion ^51^, while `date-time-tools` adds mutation capabilities (adding or subtracting days and hours). Anthropic's own documentation notes that tool use examples improve parameter-handling accuracy from 72% to 90% on complex tool calls ^52^. Despite this infrastructure, community demand persists for a built-in date-time tool in Claude Code, with users reporting that Claude "often uses outdated temporal information in its responses, referencing dates from its training data" ^53^. This gap—between protocol availability and model utilization—remains a live issue.

### 4.1.3 ReAct: Reasoning + Action Loops

The ReAct framework (Yao et al., NeurIPS 2022) interleaves reasoning traces with explicit tool invocations, overcoming chain-of-thought hallucination by grounding reasoning in real-world observations ^54^. For temporal tasks, ReAct enables LLMs to call time-related tools—Wikipedia for date lookups, calculators for duration arithmetic—during multi-step reasoning, achieving 34% absolute improvement over imitation learning on ALFWorld and 10% on WebShop. The pattern has been extended to temporal knowledge graph question answering through TempAgent (NAACL 2025 Findings), which adds temporal constraints to the retrieval process within the ReAct loop and achieves a 41.3% improvement over the baseline model ^55^. The critical feature of ReAct for time estimation is its self-correcting property: if a tool returns an unexpected timestamp, the reasoning trace can adapt the subsequent plan.

### 4.1.4 Program-Aided Language Models (PAL)

Program-Aided Language models (PAL) use the LLM to generate Python programs as intermediate reasoning steps, offloading execution to a Python interpreter ^56^. On the GSM8K math word problem benchmark, PAL using Codex surpasses PaLM-540B with chain-of-thought by an absolute 15% top-1 accuracy. PAL explicitly supports "Date and Time Calculations" as an application domain, making it directly applicable to temporal arithmetic that LLMs struggle with. The approach pairs naturally with the `dateutil` library's `relativedelta` for precise duration computations, a pattern that TReMu (Section 4.3.1) later adopted.

The following table compares the four primary tool-based approaches across mechanism, temporal scope, production readiness, and key limitation.

| Approach | Delegation Mechanism | Temporal Scope | Production Status | Key Limitation |
|---|---|---|---|---|
| **Toolformer** ^7^| Self-supervised API call generation | Calendar date, arithmetic | Research prototype | Requires training; limited to six tools |
| **MCP ecosystem** ^49^| Standardized protocol (stdio/SSE/HTTP) | Clock time, timezone, duration | Production; 97M monthly downloads | Model may still ignore tool and guess ^57^|
| **ReAct** ^54^| Reasoning-action-observation loop | Multi-step temporal retrieval | Widely deployed (LangChain, LangGraph) | Tool call overhead adds latency |
| **PAL** ^56^| Python code generation + execution | Date arithmetic, duration | Deployable via code interpreter | Requires sandboxed execution environment |

The comparative analysis reveals a shared pattern: every effective tool-based approach externalizes the computation that LLMs perform poorly (calendar math, duration arithmetic, timezone conversion) while retaining the LLM's strength in interpreting the results. None of these tools, however, address the specific problem of software engineering time estimation. MCP servers provide clock time and timezone math, but no existing server combines clock time with software estimation algorithms (PERT, COCOMO) or historical project data integration. This observation will be developed in Section 4.4.4.

---

## 4.2 Prompt Engineering and Context Modifications

If tool-based approaches redesign the interface around the LLM, prompt engineering modifies the input the model receives. This stratum of fixes is attractive because it requires no infrastructure changes, but the evidence shows its effectiveness is bounded.

### 4.2.1 Explicit Time Injection

The most widely deployed prompt-level fix is injecting the current date into the system prompt. Production-safe practice, as documented by Tian Pan (2026), requires separating stable date context (system prompt, cache-friendly) from volatile time-of-day (user message or callable tools), using ISO 8601 format anchored to UTC ^58^. The author recommends a two-month buffer zone before the actual knowledge cutoff date to prevent the model from defaulting to stale temporal anchors ^58^. Research on date-sensitive queries shows that placing the date at the beginning of the system prompt—before other instructions—produces more accurate temporal reasoning than placing it at the end ^58^. Three documented failure modes persist even with injection: models may (1) confidently emit wrong dates without calling the provided tool, (2) trigger cache misses by embedding volatile timestamps, or (3) fail at midnight rollover with cached prompts ^58^. A particularly striking report from the OpenAI community forum documents that GPT-4 "sometimes guesses dates even when explicitly instructed not to, even with temperature=0.0," intermittently hallucinating dates rather than calling a provided `GetCurrentDateTime` function ^57^. This demonstrates that prompt-level fixes reduce but do not eliminate temporal hallucination; for production systems requiring accurate temporal reasoning, tool-based approaches remain more reliable.

### 4.2.2 Urgency Cues Outperform Numeric Countdowns

The UPenn real-time negotiation study provides the most rigorous evidence on how temporal feedback should be framed. Under global wall-clock deadlines, GPT-5.1 achieved only 4% deal closure in the control condition. Explicit remaining-time updates at each turn improved closure to 32%—a 708% relative improvement ^3^. Critically, however, a qualitative urgency condition ("Deadline approaching--act with urgency.") outperformed both the numeric countdown and the control across all time budgets. The authors conclude that "the bottleneck is not simply accessing a countdown value, but mapping time pressure into an appropriate strategic policy" ^3^. This finding carries a direct implication for time estimation tools: categorical, qualitative time signals ("short," "medium," "long"; "likely," "optimistic," "pessimistic") may be more actionable for LLMs than precise numeric outputs.

### 4.2.3 Chain-of-Thought for Temporal Reasoning

Chain-of-Thought (CoT) prompting, which asks the model to generate intermediate reasoning steps before producing a final answer, shows mixed results for temporal reasoning. TimeBench (ACL 2024) found that "chain-of-thought prompting does not yield a consistent improvement in performance" across symbolic, commonsense, and event temporal reasoning tasks ^59^. GPT-4 still lags human performance by 19.4% overall on TimeBench, with the largest gap (25.2%) in event temporal reasoning ^2^. The inconsistency arises because CoT helps on arithmetic tasks (duration conversion, date math) but shows uneven improvement on implicit temporal reasoning that relies on world knowledge rather than procedural calculation. TRAVELER (2025) does find consistent CoT improvements of up to 6% on event-based QA ^14^, suggesting that the effectiveness of CoT depends on whether the task is primarily procedural (calculation) or semantic (commonsense). TReMu and PAL demonstrate that code-based intermediate steps outperform text-based CoT for temporal calculations, pointing toward a neuro-symbolic variant as the more reliable form.

---

## 4.3 Architectural and Training Interventions

Tool-based and prompt-level fixes treat the LLM as a black box. A deeper class of interventions modifies the model architecture, training data, or fine-tuning objective to internalize temporal capabilities. These approaches are more ambitious and less mature, but they offer the only path to fundamental improvement.

### 4.3.1 Neuro-Symbolic Hybrids

Neuro-symbolic approaches combine neural language understanding with symbolic or executable reasoning for temporal tasks. TReMu (2025) is the strongest result in this category: it combines time-aware memorization (timeline summarization) with neuro-symbolic temporal reasoning in which LLMs generate Python code to perform temporal calculations. On GPT-4o, TReMu raises accuracy from 29.83% with standard prompting to 77.67%—a 160% relative improvement ^60^. The framework uses the `dateutil` package's `relativedelta` for week range calculations, with execution failure rates lowest for GPT-4o and highest for GPT-3.5. NeSTR (2025) similarly integrates structured symbolic representations with hybrid reflective reasoning, encoding temporal relations through 4-tuple interval predicates and enforcing logical consistency via machine-verified abductive reflection ^61^. Agent-C (2025) applies the neuro-symbolic paradigm to safety, introducing a domain-specific language for expressing temporal properties (e.g., "authenticate before accessing data"), translating specifications to first-order logic, and using SMT solving to detect non-compliant agent actions during token generation. Agent-C achieves 100% conformance and 0% harm while improving task utility, raising Claude Sonnet 4.5 from 77.4% to 100% conformance and GPT-5 from 83.7% to 100% ^62^.

### 4.3.2 Time-Aware Architectures

Several architectures explicitly modify transformers to incorporate temporal signals. TPP-TAL introduces plug-and-play modules—Temporal Cross-Fusion plus a Multi-Scale Temporal Bias Transformer (MTBT)—that integrate temporal signals into LLM attention mechanisms without modifying pretrained parameters. MTBT introduces a per-head temporal bias mechanism using learnable time-dependent biases per attention head, allowing some heads to focus on short-term trends while others capture long-term dependencies or periodic cycles ^63^. The approach uses logarithmic bucketization for time intervals to handle varying scales and is model-agnostic, applicable to frozen LLMs. ChronoFormer, referenced in cross-dimensional analysis, modifies transformers with explicit temporal embeddings, though its effectiveness has been demonstrated only in bounded domains with unproven generalization ^64^. These architectures share a common strategy: they do not ask the LLM to represent time internally from scratch; they provide an external temporal embedding layer that the attention mechanism can attend to.

### 4.3.3 Temporal Training Paradigms

Training-based approaches modify what the model learns rather than how it reasons at inference time. TiC-LM (2025) introduces a benchmark for time-continual learning of language models, centered on TiC-CommonCrawl: 2.9 trillion possible training tokens spread across 114 monthly timesteps (May 2013 to July 2024), providing 100× more potential tokens and 10× more timesteps than prior continual learning benchmarks ^34^. The experiments find that a mix of learning rate and data replay strategies allows continual pretraining to be competitive with periodic retraining from scratch while requiring 2.6× less total compute, though domain-specific trade-offs remain (replaying old data hurts on rapidly evolving domains like StackOverflow while benefiting stable ones like Math) ^34^.

ChronoBERT (2025) takes a different approach to temporal integrity: it trains a suite of chronologically consistent language models (ChronoBERT and ChronoGPT) that incorporate only the text data that would have been available at each point in time, eliminating lookahead bias and training leakage ^65^. Despite this strict temporal constraint, ChronoBERT achieves strong performance on NLP benchmarks, matching or surpassing BERT on GLUE while generating Sharpe ratios comparable to much larger Llama models in asset pricing applications ^66^. The yearwise fine-tuning approach—training a separate model checkpoint for each calendar year—demonstrates that chronological consistency is achievable without catastrophic performance loss, though the trade-off is model fragmentation: 25 yearly checkpoints from 2000 to 2024 rather than a single model with a knowledge cutoff. This fragmentation creates operational complexity for deployment pipelines, as inference systems must route queries to the appropriate vintage based on the temporal scope of the question. For real-time applications requiring up-to-the-minute accuracy, the yearwise approach may be too coarse; for historical analysis requiring no lookahead bias, it may be exactly the right granularity.

---

## 4.4 Ongoing Research and Future Outlook

The preceding sections catalog fixes that exist today. This section maps the research frontier: the trajectories, benchmarks, architectures, and infrastructure gaps that will shape the next 3–5 years of LLM time estimation.

### 4.4.1 METR Time Horizon Projections

METR's time horizon methodology has become the gold standard for measuring autonomous AI capability. The framework fits a logistic regression curve predicting task success probability as a function of human completion time, with the 50% time horizon defined as the duration at which the curve intersects 50% success probability ^43^. As of early 2026, Claude Opus 4.5 achieves a 50% time horizon of approximately 320 minutes, while GPT-5 reaches approximately 214 minutes. Capabilities are doubling approximately every 89 days (~3 months), a 20% acceleration from prior estimates of 6–7 months ^44^. METR's foundational paper (2024) found that frontier AI time horizon had doubled approximately every seven months since 2019, and projected that if trends continue, AI could automate many software tasks taking humans a month within 5 years ^46^.

A critical distinction must be drawn here: METR measures how long AI models take to *complete* tasks (time horizon), which is different from asking an LLM to *estimate* how long a task will take before starting. The former is empirical measurement; the latter is predictive reasoning. Current research conflates these, leading to tools that measure but do not estimate. Coding agents need prediction with confidence intervals, range estimates, and uncertainty quantification—not merely post-hoc duration logging.

### 4.4.2 Emerging Benchmarks

The evaluation landscape for temporal reasoning is maturing rapidly across multiple fronts. TimeBench (ACL 2024) remains the most comprehensive hierarchical benchmark, with 10 tasks and 16 sub-tasks across symbolic, commonsense, and event temporal reasoning, documenting a 19.4% gap between GPT-4 and human performance ^2^. The TicToc benchmark (2026) introduced the concept of "temporal blindness": without timestamps, LLM agents perform near-random (maximum 55% alignment); with timestamps, the best model achieves less than 65% normalized alignment rate. Post-training with Direct Preference Optimization (DPO) demonstrates massive improvement potential across all trained models ^47^. TempoBench (2025) takes a formally grounded approach, using finite-state automata synthesized from Linear Temporal Logic (LTL) specifications to evaluate multi-step temporal and causal reasoning, revealing that LLMs achieve only 7.5% F1 on hard temporal causal evaluation tasks ^11^. TIMER-Bench (ICLR 2025) addresses the clinical domain, evaluating temporal reasoning over longitudinal Electronic Health Records and revealing critical limitations including poor temporal boundary adherence, inaccurate trend analysis, and chronological confusion ^17^.

### 4.4.3 Future Architectures

Three architectural directions are actively being pursued. First, Time-Aware World Models (TAWM) condition on time-step size $\Delta t$ and train over diverse $\Delta t$ values rather than fixed time-steps, learning both high- and low-frequency dynamics and consistently outperforming fixed-$\Delta t$ baselines across control tasks ^45^. Second, the "Language Models Are Implicitly Continuous" paper (ICLR 2025) demonstrates that transformer-based LMs implicitly learn continuous-time functions over continuous input space, suggesting that LLMs reason about language in ways fundamentally different from discrete sequence models—an observation that could be exploited for explicit continuous-time architectures ^67^. Third, neuromorphic computing offers an alternative paradigm entirely: spiking neural networks (SNNs) on chips like IBM TrueNorth and Intel Loihi achieve 100–1000× energy efficiency improvements for temporal data processing compared to GPUs and CPUs, with a dedicated benchmark (NSA) now emerging to evaluate SNN temporal capabilities ^68^.

Recent work also shows that small models with specialized training can outperform models 200× larger on temporal tasks. Time-R1 (2025) uses a three-stage reinforcement learning curriculum to endow a 3-billion-parameter model with comprehensive temporal abilities, outperforming the 671-billion-parameter DeepSeek-R1 on future event prediction benchmarks ^69^. AdapTime (ACL 2026) proposes an adaptive temporal reasoning method using three actions (reformulate, rewrite, review) guided by an LLM planner, with Qwen-3-8B equipped with AdapTime surpassing GPT-4 on TimeQA benchmarks ^70^.

The following table provides a structured overview of ongoing research directions, their maturity, and the specific temporal capability each addresses.

| Research Direction | Institution / Group | Maturity | Temporal Capability Addressed | Key Result |
|---|---|---|---|---|
| **METR time horizons** ^43^| METR (independent) | Production | Autonomous task duration measurement | Doubling every ~89 days; ~320 min (Claude Opus 4.5) |
| **TicToc temporal blindness** ^47^| UMD / RELAI.ai | Published 2026 | Real-time elapsed-time awareness | <65% alignment even with timestamps |
| **Time-R1 RL curriculum** ^69^| Liu et al. | Published 2025 | Future event prediction | 3B model beats 671B DeepSeek-R1 |
| **AdapTime** ^70^| XJTU / CityU / Tencent | Published 2026 | Adaptive multi-hop reasoning | Qwen-3-8B + AdapTime > GPT-4 on TimeQA |
| **TAWM** ^45^| University of Maryland | ICLR workshop | Variable-$\Delta t$ dynamics | Outperforms fixed-$\Delta t$ baselines |
| **Continuous-time LLMs** ^67^| ICLR 2025 | Published 2025 | Implicit continuity in transformers | Most SOTA LMs learn continuous-time functions |
| **Neuromorphic SNNs** ^68^| SNN research community | Benchmark phase | Temporal data processing | 100–1000× energy efficiency vs. GPU |
| **TiC-LM continual pretraining** ^34^| Multiple institutions | Published 2025 | Temporal knowledge updating | 2.9T tokens, 114 months; 2.6× compute savings |
| **ChronoBERT** ^65^| Washington University | Published 2025 | Chronological consistency / no lookahead | Matches BERT on GLUE with year-bound data |
| **Agent-C safety** ^62^| Published 2025 | Published 2025 | Temporal constraint enforcement | 100% conformance, 0% harm |

The table reveals a bimodal maturity distribution: roughly half the directions (METR, TicToc, Time-R1, TiC-LM, ChronoBERT) have published results and reproducible methodologies, while the other half (TAWM, continuous-time LLMs, neuromorphic SNNs) remain at the architecture-proposal or early-evaluation stage. The production-ready quadrant (METR, TicToc, Agent-C) focuses on measuring or constraining temporal behavior, whereas the speculative quadrant (TAWM, continuous-time LLMs, SNNs) aims to change the fundamental capacity of models to represent time. All ten directions, however, share a common recognition: temporal reasoning is not automatically solved by general capability scaling, and targeted interventions—whether algorithmic, architectural, or training-based—are necessary. The divergence in approach mirrors a deeper strategic choice in the field: whether to make time externally legible to existing models through tools and protocols, or to rebuild models from the ground up with intrinsic temporal representations. The evidence to date suggests that the external-legibility path delivers reliable improvements today, while the intrinsic-representation path remains necessary for long-term solutions but carries higher technical risk and longer development horizons.

### 4.4.4 The Estimation Infrastructure Vacuum

The chapter concludes by identifying the most actionable gap in the current landscape. The MCP ecosystem has time-related servers (passage-of-time-mcp, mcp-time) and software estimation research exists (SEEAgent, LLM-aware estimation frameworks), but no tool combines these domains. No existing MCP server integrates clock time, calendar math, software estimation algorithms (PERT, COCOMO, function points), and historical project data from PM systems (Jira, Asana, Toggl). This is not a technical impossibility—all components exist separately—but a product-market fit failure: the problem was previously attributed to "LLMs can't estimate" rather than "LLMs lack estimation tools."

The vacuum is particularly acute in light of the findings from Chapter 3. Traditional estimation models assume human labor and break down in LLM-assisted development. Current coding agents use token budgets as implicit (but broken) time budgets, with no agent saying "this will take 45 minutes" because they reason in tokens, not minutes. METR measures time horizons but does not provide estimation tools. The result is a system in which agents are asked to estimate duration but given no tools to do so accurately.

The next chapter translates this diagnosis into an architecture for building a Time Estimation MCP Server—a greenfield opportunity that combines the tool-based delegation pattern validated by Toolformer and MCP with the software estimation domain knowledge that existing servers lack.


---

# 5. Architecture: Designing a Time Estimation MCP Server

The preceding chapters established why LLM coding agents fail at time estimation: the problem is a compound fracture of architectural limitations, replicated human cognitive biases, and domain-specific estimation breakdowns. The evidence also pointed to a clear gap—no existing MCP server or tool combines clock time, calendar mathematics, software estimation algorithms, and historical data integration into a single system. This chapter translates those research findings into an architectural blueprint. The goal is not to make LLMs "better at time" through training or prompting tricks, but to build an external estimation infrastructure that makes time *legible* to LLMs through structured, requestable representations.

## 5.1 Design Philosophy and Core Principles

Any architecture for a time estimation MCP server must be grounded in the empirical findings from the research phase. Four principles emerged as non-negotiable constraints on the design.

### 5.1.1 Make Time Legible to LLMs, Not Make LLMs Better at Time

The most important design decision is a reframing of the problem itself. Research Insight 5 established that the fix is not improving the LLM's internal temporal reasoning, but making time information externally legible in formats the LLM can already process ^6^. This distinction is subtle but architecturally decisive.

LLMs excel at discrete, token-aligned temporal tasks—before/after relations, event ordering, turn-based negotiation—because these map to sequence-ordering problems that self-attention handles well ^2^. They fail catastrophically at continuous, wall-clock temporal tasks—elapsed time tracking, duration estimation, real-time deadline management—because continuous time tracking requires accumulation and counting, operations that self-attention is theoretically incapable of performing ^2^. Any attempt to "train" an LLM to track elapsed time architecturally runs into this theoretical ceiling.

The Toolformer paper from Meta AI (NeurIPS 2023) provided the foundational evidence for this approach: LLMs can teach themselves to use external tools via simple APIs, achieving substantially improved zero-shot performance without sacrificing core language modeling abilities ^7^. The calendar tool in Toolformer specifically addressed "unawareness of the progression of time," which the authors listed as one of several inherent limitations of language models that could not be resolved through scale alone ^48^.

The architectural implication is direct: the MCP server should not attempt to teach the LLM temporal reasoning. Instead, it should expose time as structured data that the LLM can *request* but never needs to *calculate*. When an agent needs to know "how many business days until the sprint deadline," it calls a tool. The server performs the calculation using `workalendar` for holiday-aware arithmetic, `pendulum` for timezone-safe date math, and returns a structured result. The LLM reads the answer; it does not compute it. This pattern—external delegation of continuous-time operations—mirrors how we give humans calculators: the cognitive work is offloaded, not taught.

### 5.1.2 Categorical Outputs Alongside Numeric

Research Insight 4 revealed a counterintuitive but robust finding: qualitative urgency cues outperform explicit numeric countdowns for improving LLM behavior under time pressure ^3^. In the UPenn negotiation study, the condition with qualitative urgency reminders ("Deadline approaching—act with urgency") achieved higher deal-closure rates than the condition with explicit numeric countdowns ("137 seconds left") ^3^. The researchers concluded that "the bottleneck is not simply accessing a countdown value, but mapping time pressure into an appropriate strategic policy" ^3^.

This finding has direct architectural consequences. Every time estimation tool in the server should return *both* a precise numeric estimate and a categorical classification. For task duration, the categorical output might be `"urgency": "short"` (under 2 hours), `"medium"` (2 hours to 2 days), or `"long"` (over 2 days). For schedule risk, the output might include `"confidence": "likely"` (P50), `"optimistic"` (P20), or `"pessimistic"` (P80). The numeric value serves human review and downstream calculation; the categorical value serves the LLM's policy adaptation.

This dual-output pattern also aligns with how human time perception operates. Humans do not experience "47 minutes remaining" as a continuous numeric value; they experience "getting close" or "plenty of time" ^3^. By providing categorical classifications, the MCP server bridges between the precision required for project management and the qualitative signals that LLMs can actually act upon.

### 5.1.3 Bridge Token-Space and Time-Space

Research Insight 8 identified that LLM agents currently use token budgets (200K–500K tokens per session) as a proxy for time budgets, but this mapping is broken ^5^. Tokens do not linearly correlate with wall-clock time due to three confounding factors: reasoning-time variation (a single reasoning step may consume thousands of tokens in seconds or minutes, depending on model and complexity), tool-call latency (each external API call adds round-trip time independent of token count), and API speed variation (different providers and rate limits produce different tokens-per-second throughput).

The architectural response is an explicit token-to-time mapping layer inside the MCP server. This is not a single conversion factor but a parametric model:

$$
\text{Estimated Wall-Clock Time} = \frac{\text{Tokens}}{\text{Tokens/Second}} + (\text{Tool Calls} \times \text{Average Latency}) + \text{Reasoning Overhead}
$$

Where *Reasoning Overhead* is a model-specific constant derived from empirical measurement (e.g., Claude 4 Sonnet ≈ 2.3 seconds per 1K reasoning tokens under typical load), and *Average Latency* is measured per-tool from the server's own request logs. The server maintains a calibration table that the LLM can query: `get_token_time_mapping(model="claude-sonnet-4", tool_calls=5, reasoning_tokens=8000)` returns a distribution estimate rather than a point value.

This bridge is essential because agents currently say "I'll complete this in a few steps" when they mean "this will fit within my token budget" ^5^. Without an explicit translation layer, every agent estimate is implicitly a token estimate masquerading as a time estimate—and it will be wrong.

### 5.1.4 Reference Class Forecasting Over Algorithmic Models

Research Insight 6 established that historical actual-vs-estimated data from project management systems is more valuable than algorithmic models for LLM-assisted development ^4^. The reasoning is straightforward: algorithmic models like COCOMO II and PERT assume predictable task structures and human labor rates, but LLM-assisted development is highly variable. METR's "messiness" factors (complexity, ambiguity, novelty, dependency count, tool unfamiliarity) each degrade performance by approximately 8% per point on a 16-point scale ^4^. No algorithmic model captures these idiosyncratic, team-specific factors.

Kahneman's reference class forecasting—estimating from the outside by examining how similar tasks actually unfolded—outperforms inside-view estimation for humans, and the same logic applies to LLM agents ^71^. If the last twelve "refactor authentication" tasks in Jira averaged 2.3× their initial estimates, the server should apply a 2.3× correction factor to the next such estimate, transparently reporting the adjustment.

The architectural implication is that Layer 4 (Data Integration) and Layer 5 (Advanced Analytics) must be treated as *primary* estimation sources, while Layer 3 (Software Estimation Algorithms) serves as a fallback when historical data is sparse. This inverts the traditional hierarchy where algorithmic models are primary and historical data is supplementary.

**Table 1: Core Design Principles for the Time Estimation MCP Server**

| Principle | Research Basis | Architectural Manifestation |
|-----------|---------------|----------------------------|
| Make time legible, not LLMs better at time | LLMs lack continuous-time module architecturally ^2^; Toolformer proved tool delegation works ^7^| Structured external representations; LLM requests calculations, never performs them |
| Categorical outputs alongside numeric | Urgency cues outperform numeric countdowns by mapping to policy, not arithmetic ^3^| Every tool returns `"urgency"` and `"confidence"` classifications alongside precise values |
| Bridge token-space and time-space | Token budgets act as broken implicit time budgets ^5^| Explicit parametric model with model-specific calibration tables |
| Reference class forecasting over algorithms | Historical actual-vs-estimated data captures team-specific messiness factors ^4^ ^71^| PM system integration (Jira, Toggl) as primary source; algorithmic models as fallback |

These four principles constrain every subsequent architectural decision. A server that violates any of them—by asking the LLM to compute durations, by returning only numeric outputs, by ignoring token-to-time translation, or by privileging COCOMO over Jira actuals—will reproduce the same estimation failures that motivated this work.

## 5.2 Five-Layer Server Architecture

The architecture organizes functionality into five ascending layers, each building on the layers below. Layer 1 handles what existing time MCP servers already do; Layers 2–5 address the gaps identified in the research. The full architecture is shown in Figure 1.

**Figure 1. Five-Layer Time Estimation MCP Server Architecture.** The diagram shows five functional layers (Core Temporal Primitives through Advanced Analytics) above an MCP Protocol Integration Layer that exposes the functionality to LLM clients via registry-based tool dispatch. Three design principles—making time legible to LLMs, bridging token-space to time-space, and providing categorical outputs alongside numeric—are annotated at the top. Transport options (stdio for local development, Streamable HTTP for production) are shown on the right.

### 5.2.1 Layer 1 — Core Temporal Primitives

Layer 1 provides the foundation that existing MCP time servers (passage-of-time-mcp, mcp-time) already demonstrate is necessary ^72^ ^73^. These are the operations that LLMs demonstrably cannot perform reliably: current time retrieval, timezone conversion, timestamp parsing, duration calculation, and elapsed-time tracking.

The implementation strategy is straightforward but must be rigorous. All timestamps are stored and transmitted in UTC (ISO 8601 format), with timezone identifiers using IANA names (`America/New_York`, not `EST`) to handle Daylight Saving Time transitions correctly ^74^. Duration parsing must handle both precise formats (`P3DT12H30M` per ISO 8601) and natural language (`"3 business days from now"`, `"end of Q3"`) through the `dateparser` library ^75^. Human-readable formatting—`diff_for_humans()` in Pendulum terminology—should be included alongside raw timestamps because LLMs process relative descriptions ("2 hours ago") more reliably than absolute timestamps ^74^.

A subtle but critical requirement is elapsed-time tracking across conversation turns. The passage-of-time-mcp server demonstrated that temporal awareness enables conversation pattern analysis—spotting pauses, reasoning about rhythms, labeling a chat's "three-act structure" ^76^. For estimation purposes, the server must track how much wall-clock time has elapsed since the *start* of the current task or estimation session, because agents routinely lose track of time between messages ^2^.

### 5.2.2 Layer 2 — Calendar Math

Layer 2 is where this server diverges from all existing time MCP servers. None of the current open-source implementations support business-day calculations, holiday awareness, or working-hours constraints ^73^ ^72^. Yet these are precisely the calculations that software estimation requires: "5 business days from today" is not the same as "5 days from today," and the difference can be 2–4 calendar days depending on weekends, holidays, and the country's calendar.

The `workalendar` library provides holiday-aware business-day calculations for 80+ countries, including variable holidays (Easter, Thanksgiving) and different workweeks (Israel Sunday–Thursday, UAE Monday–Friday) ^77^. The server exposes this through tools like `business_days_between(start_date, end_date, country_code)` and `add_business_days(start_date, days, country_code)`.

Working-hours constraints are equally important for realistic scheduling. A task estimated at "8 hours" does not complete in one calendar day if the team's working day is 6 hours. The server must support configurable working hours per team or project, and schedule constraint checking (`is_within_working_hours(timestamp, team_config)`).

Recurring pattern detection completes Layer 2. Stand-ups, sprint planning, deployment windows, and maintenance periods all recur on predictable patterns that affect scheduling. The server should detect and expose these patterns from calendar API data, enabling estimates like "the earliest possible completion is the Tuesday after the next deployment freeze."

### 5.2.3 Layer 3 — Software Estimation Algorithms

Layer 3 provides the classic software estimation algorithms, but with two important adaptations for the LLM-assisted context. First, the parameters must be adjusted to account for LLM-specific cost drivers: reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight [^HC-4^]. Second, every algorithm must return probabilistic outputs (ranges and confidence intervals) rather than point estimates, because the research showed that single-number estimates are systematically wrong ^71^.

**PERT three-point estimation** uses the Beta distribution formula $E = (O + 4M + P) / 6$ with variance $\sigma^2 = ((P - O) / 6)^2$, where $O$ = optimistic, $M$ = most likely, and $P$ = pessimistic ^78^. For LLM-assisted tasks, the pessimistic estimate should explicitly account for iteration cycles—if the first attempt fails 35% of the time (per METR empirical data ^4^), the PERT parameters should reflect expected rework.

**COCOMO II** provides parametric effort estimation at the project level ^79^. The LLM-adapted version replaces the 17 human-labor cost drivers with LLM-specific factors: prompt engineering complexity, context window requirements, reasoning depth (chain-of-thought steps), tool integration count, and human review checkpoints. The scale factors (novelty, flexibility, risk resolution, team cohesion, process maturity) remain relevant but must be reinterpreted for human+LLM hybrid teams.

**Story Point velocity tracking** requires a local database of sprint data. The server computes velocity as the rolling average of story points completed per sprint, with conversion to hours via the team-specific factor $\text{Total Sprint Hours} \div \text{Average Velocity}$ ^80^. This conversion factor must be recalibrated every 3–4 sprints ^80^, and the server automates this recalculation.

**Critical Path Method (CPM)** computes Early Start, Early Finish, Late Start, Late Finish, and Slack for each task in a dependency graph ^81^. The LLM-adapted version adds a "merge bias" adjustment: the more predecessors a task has, the less probable it is to start on time, a phenomenon that traditional CPM ignores but Monte Carlo simulation captures ^82^.

**Function Point Analysis** quantifies software size from requirements ^83^. The challenge here is standard fragmentation: IFPUG, COSMIC, FiSMA, NESMA, and Mark II are all ISO standards but "generally not comparable" ^84^. The server should default to COSMIC for new projects (better suited to modern software architectures) while supporting IFPUG for legacy compatibility.

### 5.2.4 Layer 4 — Data Integration

Layer 4 is the most important differentiator of this architecture. No existing MCP server connects to project management systems to pull actual-vs-estimated time data ^73^ ^72^. Without this layer, the server is a calculator with no memory—it cannot learn from past estimation errors.

The integration targets are:

- **Jira REST API**: worklogs (`GET /rest/api/2/issue/{key}/worklog`), estimated time fields, and JQL search for historical issues by type and complexity ^85^.
- **Asana API**: native Estimated Time and Actual Time custom fields, with subtask rollups ^86^.
- **Toggl Track / Clockify / Harvest APIs**: time entry data with project and task categorization ^87^ ^88^.
- **Git commit history**: `git log` analysis to infer actual development time from commit timestamps and file change patterns.
- **Calendar APIs**: Google Calendar, Outlook, CalDAV for blocked-time analysis and meeting overhead calculation.

The reference class forecasting database is built from this data. For each task category (e.g., "API endpoint implementation," "database migration," "frontend component"), the server maintains a distribution of actual-vs-estimated ratios. When a new estimate is requested, the server queries this distribution and applies the historical correction factor. If "API endpoint implementation" tasks have historically taken 1.8× their estimate, the server returns both the raw algorithmic estimate and the corrected estimate, with transparency about the adjustment.

### 5.2.5 Layer 5 — Advanced Analytics

Layer 5 provides the probabilistic and self-correcting capabilities that turn estimation from guesswork into forecast engineering.

**Monte Carlo simulation** generates range estimates by running thousands of schedule simulations with randomized task durations drawn from the historical distributions in Layer 4 ^89^. The output is not "the project completes on March 15" but "P50 completion is March 15, P80 completion is March 22"—a statement the LLM can use to communicate realistic expectations.

**Planning fallacy correction factors** are computed per-team by comparing estimated vs. actual times across the historical database ^71^. If a team's estimates are consistently 1.5× too low, the server applies a 1.5× multiplier and records the adjustment in the output metadata. The correction factor is recomputed monthly and trends are reported so teams can observe whether their estimation accuracy is improving.

**Team-specific velocity calibration** goes beyond simple story-point conversion. It accounts for team composition changes (new hire → velocity dip for 2 sprints), technical debt accumulation (velocity decay over quarters), and seasonal variation (holiday periods, conference seasons).

**Estimation accuracy tracking** closes the feedback loop. Every estimate produced by the server is logged with its inputs, assumptions, and confidence level. When actual completion data arrives from Layer 4 integrations, the server computes accuracy metrics (MAPE, bias, variance) and exposes them through resources that the LLM can query to improve future estimates.

**Table 2: Five-Layer Architecture Summary**

| Layer | Domain | Key Capabilities | Existing Coverage | Gap Status |
|-------|--------|-----------------|-------------------|------------|
| 1 — Core Temporal | Clock time, timezone, duration | Current time, timezone conversion, timestamp parsing, duration arithmetic, elapsed-time tracking | passage-of-time-mcp, mcp-time provide partial coverage ^73^ ^72^| Narrow—no elapsed-time across turns |
| 2 — Calendar Math | Business days, holidays, working hours | Business-day calculation (80+ countries), holiday awareness, working-hours constraints, recurring pattern detection, DST handling | **None**—no existing MCP server covers this ^73^ ^72^| Major gap |
| 3 — Software Estimation | PERT, COCOMO, Story Points, CPM, Function Points | Three-point estimation with Beta distribution, LLM-adapted parametric models, velocity tracking, critical path analysis, functional sizing | **None**—no existing MCP server covers this ^73^ ^72^| Major gap |
| 4 — Data Integration | Jira, Asana, Toggl, Git, Calendar APIs | Worklog retrieval, actual-vs-estimated comparison, reference class database construction, commit history analysis | Harvest MCP Server covers one vendor ^90^| Major gap |
| 5 — Advanced Analytics | Monte Carlo, confidence intervals, correction factors | Probabilistic schedule simulation, P50/P80 forecasts, planning fallacy correction, team velocity calibration, accuracy tracking | **None** | Major gap |

The table makes the gap explicit: existing time MCP servers cover approximately 15–20% of the required functionality. The remaining 80% is unimplemented territory, which explains why coding agents still give wrong time estimates—they simply have no tool that combines all five layers.

## 5.3 MCP Protocol Integration

The five functional layers must be exposed to LLM clients through the Model Context Protocol (MCP), which has become the de facto standard for connecting AI agents to external systems with 97 million monthly SDK downloads and 10,000+ active public servers ^91^. MCP's core value proposition is model-agnostic portability: build the server once, and it works with Claude, GPT, Gemini, DeepSeek, or any MCP-compatible host ^92^.

MCP defines three server-side primitives ^93^: **Tools** (executable functions with JSON Schema inputs, analogous to POST endpoints), **Resources** (read-only data access via URIs, analogous to GET endpoints), and **Prompts** (reusable parameterized templates that are user-controlled and never auto-triggered ^94^). The 2025-11-25 specification added an experimental **Tasks** primitive for long-running asynchronous operations ^93^. This section covers how each primitive is applied in the time estimation server.

### 5.3.1 Tool Design for Context Efficiency: Registry-Based Dispatch

The most critical architectural decision in MCP tool design is how many tools to expose. Anthropic's own engineering research confirms that tool definitions overload context windows, and intermediate tool results consume additional tokens—the two primary patterns that increase agent cost and latency at scale ^95^. GitHub's official MCP server consumes 17,600 tokens of tool definitions per request ^96^. Connecting multiple servers can reach 30,000+ tokens of metadata before the agent does any work ^96^.

The Harness MCP server v2 demonstrated the solution: a registry-based dispatch model that reduced tools from 130+ to 11, cutting tool-definition context cost from approximately 26% to approximately 1.6% of a 200K-token window ^21^. The pattern is not "fewer features" but "different architecture": the LLM reasons about *what* to do ("estimate this project's duration"), and the server handles *how* to do it via a registry that maps operation types to the appropriate layer and algorithm.

For the time estimation server, the 11 consolidated tools are:

1. `temporal_status()` — Layer 1: current time, elapsed session time, timezone context
2. `time_math(operation, operands)` — Layer 1–2: duration arithmetic, business-day math, timezone conversion via registry dispatch
3. `pert_estimate(tasks[])` — Layer 3: three-point estimation with Beta distribution
4. `cocomo_estimate(params)` — Layer 3: parametric effort estimation with LLM-adapted cost drivers
5. `sprint_forecast(backlog, velocity_history)` — Layer 3: story-point-based completion forecasting
6. `critical_path(tasks[])` — Layer 3: CPM with merge-bias adjustment
7. `fetch_historical_data(source, filters)` — Layer 4: unified PM system query (Jira, Asana, Toggl, etc.)
8. `reference_class_estimate(task_type, complexity)` — Layer 4–5: data-driven estimate with correction factor
9. `monte_carlo_simulation(tasks[], iterations)` — Layer 5: probabilistic schedule risk analysis
10. `calibrate_estimates(team_id, period)` — Layer 5: velocity and correction factor recalculation
11. `token_time_bridge(tokens, model, tool_calls)` — Layer 1–5: explicit token-to-wall-clock mapping

The `time_math` tool exemplifies registry dispatch. Instead of exposing separate tools for `add_days`, `add_business_days`, `convert_timezone`, `parse_natural_language`, and `format_duration`, there is one tool with an `operation` parameter that the registry routes to the correct Layer 1 or Layer 2 function. The LLM provides the semantic intent; the server resolves the implementation.

### 5.3.2 Tool Schemas and Descriptions

MCP tool descriptions are "smelly"—purely natural-language-based alignment can lead to inefficiency, and augmented descriptions with structured metadata improve agent efficiency ^97^. For this server, every tool schema must satisfy three constraints: minimal token footprint (under 500 tokens per tool definition), Pydantic/Zod validation with `.describe()` on every parameter, and explicit `readOnlyHint` annotations where applicable.

The 500-token target is aggressive but achievable. The Harness v2 server proved that 11 tools can fit in ~1.6% of a 200K context window, which implies approximately 290 tokens per tool on average ^21^. Atlassian's `mcp-compressor` proxy demonstrates that high compression (tool names + parameter names only) achieves 88% reduction to ~2,200 tokens for a large server, while maximum compression (single `list_tools()` function) reaches 97% reduction to ~500 tokens ^96^. The registry-based approach sits in the middle: enough description for the LLM to select correctly, not so much that it drowns out the user's actual request.

Every parameter must carry a `.describe()` annotation that explains not just what the parameter is, but how the LLM should think about filling it. For example, the `pert_estimate` tool's `most_likely` parameter should be described as: "Your best-guess duration if everything goes reasonably well. Do NOT use your initial optimistic guess—historical data shows initial estimates average 1.5× too low." This embeds the planning fallacy correction directly into the parameter description, nudging the LLM toward more realistic inputs.

Tool annotations (shipped in the 2025-03-26 MCP specification) serve as a "risk vocabulary" ^98^. All estimation tools are read-only (`readOnlyHint: true`) and non-destructive (`destructiveHint: false`), which lets MCP clients auto-approve them without human confirmation. Tools that write to PM systems (updating Jira worklogs, creating time entries) carry `destructiveHint: true` and trigger the confirmation workflow.

**Table 3: MCP Tool Schema Specifications for the 11 Consolidated Tools**

| Tool Name | Layer | Primary Function | Key Parameters | Output Schema | readOnlyHint |
|-----------|-------|-----------------|----------------|---------------|--------------|
| `temporal_status` | 1 | Current time context, session elapsed time | `timezone` (IANA string), `include_session_time` (bool) | `{utc_time, local_time, elapsed_session_ms, is_business_hours}` | true |
| `time_math` | 1–2 | Registry-dispatched time calculations | `operation` (enum: add_days, add_business_days, diff, convert_tz, parse_nl, format), `operands` (object) | `{result, result_human_readable, operation_applied}` | true |
| `pert_estimate` | 3 | Three-point Beta distribution estimation | `tasks[]` (each with `optimistic`, `most_likely`, `pessimistic`, `name`) | `{expected, variance, std_dev, confidence_interval_95, urgency_category}` | true |
| `cocomo_estimate` | 3 | LLM-adapted parametric effort model | `size_kloc`, `stage` (enum), `cost_drivers` (object), `scale_factors` (object) | `{effort_person_months, schedule_months, team_size, range_low, range_high}` | true |
| `sprint_forecast` | 3 | Velocity-based completion prediction | `backlog_points`, `velocity_history[]`, `sprint_length_days` | `{sprints_required, completion_date, confidence_80, risk_flags[]}` | true |
| `critical_path` | 3 | CPM with merge-bias adjustment | `tasks[]` (each with `duration`, `predecessors[]`, `name`) | `{critical_path_tasks[], slack_per_task[], merge_bias_adjustment}` | true |
| `fetch_historical_data` | 4 | Unified PM system query | `source` (enum: jira, asana, toggl, git, calendar), `filters` (object), `date_range` | `{records[], summary_stats, data_quality_score}` | true |
| `reference_class_estimate` | 4–5 | Data-driven estimate with correction | `task_type` (enum), `complexity` (1–5), `team_id` (optional) | `{raw_estimate, corrected_estimate, correction_factor, sample_size, confidence}` | true |
| `monte_carlo_simulation` | 5 | Probabilistic schedule risk analysis | `tasks[]`, `iterations` (default 10,000), `correlation_matrix` (optional) | `{p10, p50, p80, p95, critical_path_probability, risk_events[]}` | true |
| `calibrate_estimates` | 5 | Recalculate team correction factors | `team_id`, `period_days` (default 90), `minimum_samples` (default 10) | `{correction_factor, accuracy_trend, velocity_trend, recommendations[]}` | false (writes calibration data) |
| `token_time_bridge` | 1–5 | Explicit token-to-wall-clock mapping | `tokens`, `model` (enum), `tool_calls` (int), `reasoning_depth` (enum) | `{estimated_seconds, estimated_minutes, confidence, breakdown}` | true |

The schema design reflects the core principles from Section 5.1. Every estimation tool returns both a precise value and a categorical classification (`urgency_category`, `confidence`, `risk_flags`). The `token_time_bridge` tool directly implements the token-to-time mapping principle. The `reference_class_estimate` tool prioritizes historical data over algorithmic models. And the `time_math` registry dispatch minimizes context window consumption while maximizing coverage.

### 5.3.3 Resource and Prompt Templates

MCP Resources provide read-only data access via URIs following RFC 6570 URI Templates with parameterized variables ^99^. For the time estimation server, resources expose data that changes frequently but is not the result of a computation: team velocity histories, estimation methodology references, and calibration factor tables.

Key resources include:

- `velocity://{team_id}` — Rolling velocity chart data for a team, updated after each sprint completion. The LLM can subscribe to this resource to receive push notifications when velocity changes.
- `methodology://{name}` — Estimation methodology references ("How to apply PERT to LLM-assisted tasks," "Reference class forecasting guide"). These are static reference documents that help the LLM use the tools correctly.
- `accuracy://{team_id}/{period}` — Estimation accuracy metrics (MAPE, bias, variance) for a team over a specified period, enabling the LLM to report on estimation quality trends.

MCP Prompts are user-controlled templates that are never auto-triggered by the model ^94^. Following the Harness v2 skills layer pattern ^21^, the server registers prompt templates for common estimation workflows:

- `/estimate-project` — Guided multi-step workflow: break down tasks → apply PERT per task → compute critical path → run Monte Carlo → apply reference class correction
- `/sprint-plan` — Velocity-based capacity planning with story-point-to-hours conversion and risk buffer calculation
- `/schedule-milestone` — Business-day math with holiday awareness and buffer inclusion
- `/audit-estimates` — Compare estimates vs. actuals, compute correction factors, identify systematic bias patterns
- `/cocomo-assessment` — Guided function point counting → COCOMO II calculation with LLM-adapted cost drivers

Each prompt template is a parameterized MCP prompt that the user (or the LLM, via user request) selects. They are not automatic—the spec explicitly prevents auto-triggering ^94^—but they provide structured starting points that improve estimation consistency.

### 5.3.4 Transport and Deployment

MCP supports two official transport mechanisms ^100^: **stdio** (local process communication via stdin/stdout, approximately 1 ms latency, no authentication needed) and **Streamable HTTP** (remote network communication, 10–100 ms latency, supports OAuth 2.1). The older HTTP+SSE transport was deprecated in March 2025 and should not be used for new implementations ^101^.

**stdio** is the correct choice for local development and personal productivity workflows. Claude Desktop and Claude Code both spawn MCP servers as child processes and communicate through stdin/stdout ^100^. The ~1 ms latency makes stdio ideal for interactive estimation queries where the agent is making rapid successive tool calls.

**Streamable HTTP** is the correct choice for production deployment and team-shared instances. It uses a single endpoint with POST requests and optional SSE streaming, solving the dual-endpoint complexity, scalability limitations, and connection reliability issues of the deprecated SSE-only approach ^101^. For production, the MCP specification recommends stateless mode (`stateless_http=True`, `json_response=True`) for optimal horizontal scaling, though this sacrifices server-initiated capabilities like progress notifications and sampling ^102^. A time estimation server can operate statelessly because all operations are request-response: the LLM asks for an estimate, the server computes and returns it. There is no need for server-initiated sampling or long-running subscriptions.

Security considerations are paramount. A 2025 study of 2,614 MCP implementations found 82% use file system operations prone to Path Traversal (CWE-22), 67% use sensitive APIs related to Code Injection (CWE-94), and 34% related to Command Injection (CWE-78) ^103^. The time estimation server minimizes attack surface by: (1) never executing shell commands or file system operations outside its configured data directories, (2) validating all date/time inputs with strict schema enforcement, (3) using read-only mode for all estimation queries, and (4) requiring explicit confirmation for any write operation to PM systems.

Production deployment should follow the tiered risk assessment framework: Tier 1 (read-only internal operations) auto-approved; Tier 2 (single-record writes) single confirmation; Tier 3 (multi-record updates) confirmation plus audit; Tier 4 (destructive operations) multi-party approval ^104^. All estimation and query tools fall in Tier 1. Calibration updates and PM system writes fall in Tier 2 or 3.

The architecture described in this chapter—five functional layers, eleven consolidated tools with registry-based dispatch, dual-output schemas with categorical and numeric values, explicit token-to-time bridging, and reference-class forecasting prioritized over algorithmic models—constitutes the first integrated solution to the "estimation infrastructure vacuum" identified in the research. The following chapter translates this architecture into implementation, providing concrete Python and TypeScript code for each layer and tool.


---

# 6. Implementation Guide

The preceding chapter established the five-layer architecture for a Time Estimation MCP Server and the design rationale behind registry-based dispatch, token footprint minimization, and transport selection. This chapter translates those architectural decisions into runnable code. It provides complete, production-oriented implementations in both Python (with the official `mcp` SDK and FastMCP) and TypeScript (with the official `@modelcontextprotocol/sdk`), followed by testing strategies, evaluation harnesses, and benchmark targets.

The implementations presented here address the three compounding causes of estimation failure identified in Chapter 2: the LLM's architectural inability to track continuous wall-clock time, the replication of human planning fallacy from training data, and the mismatch between traditional estimation models and LLM-assisted development workflows. Rather than attempting to improve the model's internal temporal representation — an approach constrained by transformer theoretical limits — the server makes time information externally legible through structured tool interfaces. ^2^ ^1^The LLM requests calculations; it does not perform them.

### 6.1 Python Implementation with FastMCP

#### 6.1.1 Project Setup: pyproject.toml, uv Dependency Management, and Async Patterns

Modern Python MCP projects use `uv` for dependency management and `pyproject.toml` for packaging. The single required runtime dependency is `mcp[cli]`, which bundles the FastMCP framework and command-line tools (`mcp dev`, `mcp install`). ^10^For temporal computation, add `pendulum` (timezone-aware datetime replacement), `isodate` (ISO 8601 duration parsing), `workalendar` (business-day calculations across 80+ countries), and `python-dateutil` for natural-language parsing. ^74^ ^77^The `pyproject.toml` below defines a stdio-entry script, optional dev dependencies for pytest, and the minimum Python version. FastMCP supports both synchronous `run()` and asynchronous `run_async()` APIs; for a time-estimation server that may call external calendar APIs, async handlers are essential to avoid blocking the event loop. ^5^#### 6.1.2 Core Server Structure: Decorators, Initialization, and stdio Transport

FastMCP infers tool metadata — name, description, and JSON Schema input definitions — from function signatures and docstrings. ^2^The `@mcp.tool()` decorator registers each estimation function, while `mcp.run(transport="stdio")` starts the JSON-RPC 2.0 message loop over standard input/output. Stdio is the default transport for local development: latency is approximately 1 ms, no authentication is needed, and the host spawns the server as a child process. ^20^The canonical entry point pattern is `if __name__ == "__main__": mcp.run(transport="stdio")`. ^9^A critical constraint for stdio servers is that no data except JSON-RPC messages may be written to stdout; any `print()` or `console.log()` corrupts the stream. All logging must go to stderr or structured log files. ^14^#### 6.1.3 Layer 1 Implementation: Core Temporal Primitives

Layer 1 provides the foundational time operations that existing MCP servers such as `passage-of-time-mcp` and `mcp-time` already cover: current time retrieval, timezone conversion, and duration parsing. ^72^ ^73^The passage-of-time server was explicitly built to address the finding that "LLMs can't reliably calculate time differences" — a motivation that applies directly to our estimation use case. ^72^The Python implementation uses `pendulum` as a drop-in replacement for native `datetime`, eliminating naive datetimes and handling DST transitions correctly. ^74^`isodate.parse_duration()` handles ISO 8601 duration strings such as `P3Y6M4DT12H30M5S`, returning a custom `Duration` object for year/month components that `timedelta` cannot represent. ^105^`dateparser` enables natural-language inputs such as "next Friday" or "15 Juni 2026" across multiple languages. ^106^Each Layer 1 tool returns a structured JSON object containing both a machine-readable result (for downstream tool composition) and a human-readable summary (for LLM context). This dual-output pattern aligns with the `structuredContent` mechanism introduced in MCP specification revision 2025-06-18, where structured data can drive client widgets while concise text minimizes token consumption in the LLM context window. ^43^#### 6.1.4 Layer 2 Implementation: Calendar Math and Business Days

Layer 2 extends Layer 1 with calendar-aware calculations that are absent from existing time MCP servers: business-day arithmetic, holiday detection, and working-hours validation. ^73^The `workalendar` library provides holiday-aware business-day calculations for 80+ countries, handling variable workweeks (Israel Sunday–Thursday, UAE Monday–Friday) and moveable holidays such as Easter and Thanksgiving. ^77^DST transitions create two edge cases that any production time server must handle: "ambiguous times" (fall back — two 1:30 AM instances exist) and "invalid times" (spring forward — 2:30 AM does not exist). The implementation detects these conditions and returns domain errors with `isError: true`, enabling the LLM to retry with explicit disambiguation rather than silently producing incorrect results. ^12^Tool annotations communicate operational characteristics to AI clients without consuming context tokens. A time estimation tool should set `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false` (unless calling external APIs), signaling that the tool is safe to invoke speculatively. ^44^The MCP specification treats annotations as hints rather than guarantees, but defaults are pessimistic — a tool without annotations is assumed potentially destructive. ^98^#### 6.1.5 Layer 3 Implementation: PERT, Story Point Velocity, and COCOMO-Adapted Parametric Model

Layer 3 addresses the software estimation algorithms that constitute the primary differentiation of this server. The PERT (Program Evaluation and Review Technique) formula produces a weighted expected time from three-point estimates: $E = (O + 4M + P) / 6$, where $O$ is optimistic, $M$ most likely, and $P$ pessimistic. The Beta distribution weighting gives 4x emphasis to the most-likely estimate because it follows the Normal Distribution shape more accurately than simple triangular averaging. ^78^For story point conversion, the server accepts a velocity history array and computes a conversion factor: $\text{Conversion Factor} = \text{Total Sprint Hours} \div \text{Average Velocity}$. ^80^Velocity should trend toward a horizontal average representing sustainable capacity; a velocity chart that shows constant increase usually reflects a process problem rather than genuine productivity growth. ^107^The MCP tool recalculates this factor automatically when new sprint data is provided, enabling the LLM to maintain current estimates without manual arithmetic.

The COCOMO II implementation adapts Barry Boehm's parametric model for LLM-assisted development. The traditional formula, $\text{PM} = A \times \text{Size}^B \times \prod(\text{EM}_i)$, assumes human-labor-driven effort. ^79^Our adaptation replaces the 17 human-oriented cost drivers with five LLM-specific factors identified in recent research: reasoning complexity (context window requirements), context completeness (amount of codebase the LLM must ingest), transformation impact (degree of architectural change), iterative cycles (expected tool-call loops), and human oversight ratio (fraction of time requiring human review). ^1^Monte Carlo simulation produces probabilistic completion dates rather than single-point estimates. The technique addresses "merge bias" — the phenomenon that the more predecessors an activity has, the less probable it is to start on time — which makes traditional CPM schedules systematically optimistic. ^82^The server exposes a configurable iteration count (default 10,000) and returns P50, P80, and P95 completion dates.

#### 6.1.6 Error Handling and LLM-Friendly Messages

MCP distinguishes domain errors (returned with `isError: true` in the tool response, for the AI to handle) from protocol errors (thrown as exceptions, for the client to handle). ^12^In FastMCP, exceptions are automatically caught and converted; `mask_error_details=True` prevents internal stack traces from leaking to the LLM context.

For time estimation, domain errors include "invalid timezone identifier," "unparseable natural language expression," and "insufficient velocity data for forecast" — each returned as structured JSON with `isError: true` and an actionable retry suggestion. Protocol errors include missing required parameters (handled by Pydantic validation before the tool function executes). FastMCP's flexible validation mode coerces string representations such as `"10"` to integers, which is essential because LLM clients frequently send stringified values where numbers are expected. ^8^The complete Python implementation below consolidates 11 tools across the first three layers using a registry-based dispatch pattern. This architecture reduces tool-definition context cost from potentially thousands of tokens to under 500, aligning with the Harness MCP v2 finding that registry dispatch cut context consumption from approximately 26% to approximately 1.6% of a 200K-token window. ^21^```python
# time_estimate_server.py — Python FastMCP implementation
# Requires: uv add "mcp[cli]" pendulum isodate workalendar python-dateutil

import json
import sys
import asyncio
from typing import Any
from datetime import datetime

import pendulum
import isodate
from dateutil import parser as date_parser
from workalendar.registry import registry
from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

mcp = FastMCP(
    "time-estimate-server",
    strict_input_validation=False,   # LLMs often send stringified values ^8^mask_error_details=True,          # Hide internal stack traces ^12^)

# ── Layer 1: Core Temporal Primitives ──

@mcp.tool()
def get_current_time(timezone: str = "UTC") -> str:
    """Return current datetime in the requested timezone.

    Use this tool when the user asks "what time is it" or needs a
    timestamp anchored to now. Always provide an IANA timezone
    identifier such as America/New_York or Europe/Berlin.
    """
    try:
        now = pendulum.now(timezone)
        return json.dumps({
            "iso": now.to_iso8601_string(),
            "human": now.format("YYYY-MM-DD HH:mm:ss dddd"),
            "timezone": timezone,
            "utc_offset": now.format("Z"),
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": f"Invalid timezone: {timezone}. Use IANA identifiers like 'America/New_York'."})

@mcp.tool()
def convert_timezone(timestamp: str, target_tz: str) -> str:
    """Convert an ISO-8601 timestamp to a different timezone."""
    try:
        dt = pendulum.parse(timestamp)
        converted = dt.in_timezone(target_tz)
        return json.dumps({
            "original": timestamp,
            "converted": converted.to_iso8601_string(),
            "target_tz": target_tz,
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": str(e)})

@mcp.tool()
def parse_duration(duration_string: str) -> str:
    """Parse an ISO-8601 or natural-language duration into seconds and human-readable form.

    Examples:
      - ISO: P3Y6M4DT12H30M5S
      - Natural: 2h30m, 5 days, 1 week
    """
    try:
        # Try ISO 8601 first ^105^duration = isodate.parse_duration(duration_string)
        total_seconds = int(duration.total_seconds())
    except Exception:
        # Fallback: pendulum interval parsing
        try:
            parts = duration_string.split()
            kwargs = {}
            for i in range(0, len(parts), 2):
                val = int(parts[i])
                unit = parts[i+1].lower()
                if unit in ("second", "seconds", "s"):
                    kwargs["seconds"] = val
                elif unit in ("minute", "minutes", "min", "m"):
                    kwargs["minutes"] = val
                elif unit in ("hour", "hours", "h"):
                    kwargs["hours"] = val
                elif unit in ("day", "days", "d"):
                    kwargs["days"] = val
                elif unit in ("week", "weeks", "w"):
                    kwargs["weeks"] = val
            pi = pendulum.interval(**kwargs)
            total_seconds = int(pi.total_seconds())
        except Exception:
            return json.dumps({"isError": True, "message": f"Could not parse duration: {duration_string}"})

    return json.dumps({
        "input": duration_string,
        "total_seconds": total_seconds,
        "human": pendulum.interval(seconds=total_seconds).invert().human_readable(),
    })

# ── Layer 2: Calendar Math ──

@mcp.tool()
def add_business_days(start_date: str, days: int, country: str = "US") -> str:
    """Add N business days to a date, excluding weekends and holidays.

    Country must be a workalendar registry key such as US, UK, FR, DE.
    """
    try:
        cal_class = registry.get(country.upper())
        if not cal_class:
            return json.dumps({"isError": True, "message": f"Unsupported country: {country}"})
        cal = cal_class()
        dt = pendulum.parse(start_date)
        result = cal.add_working_days(dt.date(), days)
        return json.dumps({
            "start": start_date,
            "days_added": days,
            "result": result.isoformat(),
            "country": country,
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": str(e)})

@mcp.tool()
def count_business_days(start_date: str, end_date: str, country: str = "US") -> str:
    """Count business days between two dates, excluding weekends and holidays."""
    try:
        cal_class = registry.get(country.upper())
        if not cal_class:
            return json.dumps({"isError": True, "message": f"Unsupported country: {country}"})
        cal = cal_class()
        s = pendulum.parse(start_date).date()
        e = pendulum.parse(end_date).date()
        count = cal.get_working_days_delta(s, e)
        return json.dumps({
            "start": start_date,
            "end": end_date,
            "business_days": count,
            "country": country,
        })
    except Exception as e:
        return json.dumps({"isError": True, "message": str(e)})

# ── Layer 3: Software Estimation ──

@mcp.tool()
def pert_estimate(optimistic: float, most_likely: float, pessimistic: float,
                  unit: str = "hours") -> str:
    """Calculate PERT expected duration, variance, and standard deviation.

    Formula: E = (O + 4M + P) / 6 ^78^Variance: ((P - O) / 6)^2
    """
    if not (0 < optimistic <= most_likely <= pessimistic):
        return json.dumps({
            "isError": True,
            "message": "Values must satisfy 0 < optimistic <= most_likely <= pessimistic."
        })
    expected = (optimistic + 4 * most_likely + pessimistic) / 6
    std_dev = (pessimistic - optimistic) / 6
    variance = std_dev ** 2

    return json.dumps({
        "optimistic": optimistic,
        "most_likely": most_likely,
        "pessimistic": pessimistic,
        "expected": round(expected, 2),
        "variance": round(variance, 2),
        "std_deviation": round(std_dev, 2),
        "confidence_95": round(expected + 2 * std_dev, 2),   # E + 2 sigma
        "confidence_99": round(expected + 3 * std_dev, 2),   # E + 3 sigma
        "unit": unit,
    })

@mcp.tool()
def story_point_forecast(backlog_points: float, velocity_history: list,
                         sprint_length_days: int = 14,
                         hours_per_sprint: int = 300) -> str:
    """Forecast sprint completion date from backlog size and historical velocity.

    velocity_history: list of story points completed per past sprint.
    Returns completion date, required sprints, and confidence intervals.
    """
    if not velocity_history:
        return json.dumps({"isError": True, "message": "velocity_history cannot be empty."})

    avg_velocity = sum(velocity_history) / len(velocity_history)
    if avg_velocity <= 0:
        return json.dumps({"isError": True, "message": "Average velocity must be > 0."})

    required_sprints = backlog_points / avg_velocity
    conversion_factor = hours_per_sprint / avg_velocity
    total_hours = backlog_points * conversion_factor

    # Simple variance from velocity history
    if len(velocity_history) > 1:
        mean_v = avg_velocity
        variance = sum((v - mean_v) ** 2 for v in velocity_history) / (len(velocity_history) - 1)
        std_v = variance ** 0.5
        pessimistic_sprints = backlog_points / max(avg_velocity - std_v, 0.1)
    else:
        pessimistic_sprints = required_sprints * 1.5   # 50% buffer with single data point

    return json.dumps({
        "backlog_points": backlog_points,
        "average_velocity": round(avg_velocity, 1),
        "required_sprints": round(required_sprints, 1),
        "pessimistic_sprints": round(pessimistic_sprints, 1),
        "hours_per_point": round(conversion_factor, 2),
        "total_hours": round(total_hours, 1),
        "completion_days": round(required_sprints * sprint_length_days),
        "sprint_length_days": sprint_length_days,
    })

@mcp.tool()
def cocomo_llm_estimate(kloc: float, reasoning_complexity: float = 1.0,
                       context_completeness: float = 1.0,
                       transformation_impact: float = 1.0,
                       iterative_cycles: float = 1.0,
                       human_oversight: float = 1.0) -> str:
    """LLM-adapted COCOMO II parametric estimate.

    kloc: estimated thousands of lines of code.
    Cost drivers (1.0 = nominal, range 0.5–2.0):
      - reasoning_complexity: context window / reasoning demands
      - context_completeness: fraction of codebase accessible to LLM
      - transformation_impact: degree of architectural change
      - iterative_cycles: expected tool-call / retry loops
      - human_oversight: fraction requiring human review
    """
    A, B = 2.94, 1.10   # COCOMO II Post-Architecture defaults ^79^em_product = (reasoning_complexity * context_completeness *
                  transformation_impact * iterative_cycles * human_oversight)
    person_months = A * (kloc ** B) * em_product

    # LLM productivity factor: empirical data suggests 1.2–3.6x human speed
    # but with overhead from iterative cycles ^71^llm_overhead = 1.0 + (iterative_cycles - 1.0) * 0.15
    adjusted_pm = person_months / max(1.5, 3.0 / llm_overhead)

    return json.dumps({
        "kloc": kloc,
        "person_months_nominal": round(person_months, 1),
        "person_months_llm_adjusted": round(adjusted_pm, 1),
        "effort_multipliers": {
            "reasoning_complexity": reasoning_complexity,
            "context_completeness": context_completeness,
            "transformation_impact": transformation_impact,
            "iterative_cycles": iterative_cycles,
            "human_oversight": human_oversight,
            "product": round(em_product, 3),
        },
        "assumptions": "LLM productivity factor derived from empirical agent benchmarks. Adjust for your team's actual velocity.",
    })

# ── Entry point ──

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

### 6.2 TypeScript Implementation

#### 6.2.1 Project Setup: package.json, TypeScript SDK, and Zod Schemas

The official TypeScript MCP SDK (`@modelcontextprotocol/sdk`, 45,829 npm dependents) implements the full MCP specification with support for stdio, Streamable HTTP, tools, resources, prompts, and sampling. ^108^It requires Zod as a peer dependency for input validation; the SDK automatically converts Zod schemas to JSON Schema for the MCP protocol. ^6^A production-ready TypeScript project requires `tsconfig.json` with `module: "Node16"` and `moduleResolution: "Node16"` to handle the SDK's ESM/CJS dual packaging, plus `package.json` with `"type": "module"`. ^4^The canonical setup command is `npm install @modelcontextprotocol/sdk zod` followed by `npm install -D typescript @types/node`.

#### 6.2.2 Equivalent Layer Implementations

The TypeScript implementation mirrors the Python server layer for layer. For temporal computation, the ecosystem offers `date-fns` (tree-shakeable, functional) and `moment` (legacy but widely understood). For business-day calculations, the `date-fns` add-on `date-fns-business-days` or a custom holiday registry replaces `workalendar`. For PERT and COCOMO, the formulas are identical — the implementation difference lies in schema definition and type safety.

The `McpServer.registerTool()` method accepts a configuration object with `description`, `inputSchema` (a Zod schema), and an async handler. The `description` field and per-parameter `.describe()` strings are the primary signals the LLM uses to decide when and how to invoke the tool. ^42^Best practices include multi-line descriptions with use-case guidance, examples of when to use and when not to use, and error handling documentation.

The TypeScript equivalent below implements the same 11-tool surface as the Python server, using `date-fns` and `date-fns-tz` for temporal operations and Zod for input validation. It omits external API calls for brevity but preserves the full schema structure and error handling patterns.

```typescript
// src/index.ts — TypeScript McpServer implementation
// Requires: npm install @modelcontextprotocol/sdk zod date-fns date-fns-tz

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { format, addBusinessDays, differenceInBusinessDays } from "date-fns";
import { toZonedTime, formatInTimeZone } from "date-fns-tz";

const server = new McpServer({
  name: "time-estimate-server-ts",
  version: "1.0.0",
});

// ── Layer 1: Core Temporal ──

server.registerTool(
  "get_current_time",
  {
    description: `Return the current datetime in the requested timezone.

Use this tool when the user asks "what time is it" or needs a timestamp.
Provide an IANA timezone identifier such as America/New_York or Europe/Berlin.`,
    inputSchema: {
      timezone: z.string().default("UTC").describe("IANA timezone identifier (e.g., America/New_York)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ timezone }) => {
    try {
      const now = new Date();
      const zoned = toZonedTime(now, timezone);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            iso: now.toISOString(),
            human: formatInTimeZone(now, timezone, "yyyy-MM-dd HH:mm:ss EEEE"),
            timezone,
          }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Invalid timezone: ${timezone}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  "pert_estimate",
  {
    description: `Calculate PERT expected duration from three-point estimates.

Formula: E = (O + 4M + P) / 6. Returns expected value, variance,
standard deviation, and 95% / 99% confidence bounds.`,
    inputSchema: {
      optimistic: z.number().positive().describe("Optimistic duration estimate"),
      most_likely: z.number().positive().describe("Most likely duration estimate"),
      pessimistic: z.number().positive().describe("Pessimistic duration estimate"),
      unit: z.enum(["hours", "days", "weeks"]).default("hours").describe("Time unit"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ optimistic, most_likely, pessimistic, unit }) => {
    if (optimistic > most_likely || most_likely > pessimistic) {
      return {
        content: [{ type: "text", text: "Values must satisfy optimistic <= most_likely <= pessimistic." }],
        isError: true,
      };
    }
    const expected = (optimistic + 4 * most_likely + pessimistic) / 6;
    const stdDev = (pessimistic - optimistic) / 6;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          optimistic,
          most_likely,
          pessimistic,
          expected: Math.round(expected * 100) / 100,
          variance: Math.round(stdDev * stdDev * 100) / 100,
          std_deviation: Math.round(stdDev * 100) / 100,
          confidence_95: Math.round((expected + 2 * stdDev) * 100) / 100,
          confidence_99: Math.round((expected + 3 * stdDev) * 100) / 100,
          unit,
        }),
      }],
    };
  }
);

// ── Entry point ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);   // stderr only — never stdout ^14^process.exit(1);
});
```

#### 6.2.3 Build and Deployment: tsc Verification and mcp-proxy for Transport Conversion

Build verification follows the standard TypeScript pipeline: `npm run build` (which invokes `tsc`) compiles `src/index.ts` to `dist/index.js`. For local development, the server runs directly via `node dist/index.js` with stdio transport. For remote deployment, `mcp-proxy` converts stdio to Streamable HTTP, enabling multi-client access and load distribution. ^19^Streamable HTTP is the modern standard for remote MCP servers, replacing the deprecated SSE transport. It uses a single endpoint (`/mcp`) with POST requests and optional SSE streaming, solving the dual-endpoint complexity and connection reliability issues of the legacy approach. ^20^Production testing showed that 20 of 22 requests failed with SSE under just 20 simultaneous connections; Streamable HTTP handles multiple clients natively. ^19^The following table summarizes the layer-by-layer implementation decisions across both languages, including the primary library, key algorithm, and any LLM-specific adaptation applied.

| Layer | Tool Family | Python Library | TypeScript Library | Core Algorithm | LLM Adaptation |
|---|---|---|---|---|---|
| 1 | Core Temporal | `pendulum`, `isodate`, `dateparser` | `date-fns`, `date-fns-tz` | ISO 8601 parsing, timezone conversion, natural-language parsing | None — direct computation |
| 1 | Duration Arithmetic | `pendulum.interval` | `date-fns` interval | Add/subtract durations, human-readable formatting | Coerced string inputs accepted ^8^|
| 2 | Business-Day Math | `workalendar` (80+ countries) ^77^| Custom holiday registry + `date-fns` | Weekend exclusion, holiday-aware delta | DST transition error detection with `isError: true` ^12^|
| 2 | Working-Hours Validation | `pendulum` range check | `date-fns` range check | Business-hours boundary detection | Returns categorical urgency cues alongside numeric output ^3^|
| 3 | PERT Estimation | Native Python | Native TypeScript | Beta distribution: $E = (O + 4M + P) / 6$ ^78^| Confidence intervals (95%, 99%) rather than point estimates |
| 3 | Story Point Forecast | Native Python | Native TypeScript | Velocity averaging, conversion factor ^80^| Auto-recalculation on new sprint data; variance from history |
| 3 | COCOMO II | Native Python | Native TypeScript | $PM = A \times \text{Size}^B \times \prod(EM_i)$ ^79^| 5 LLM-specific cost drivers replace 17 human-oriented drivers ^1^|
| 3 | Monte Carlo (stub) | `random` module | `Math.random` | 10,000-iteration simulation ^89^| Merge bias correction for multi-predecessor tasks ^82^|

The table reveals a consistent implementation pattern: Layers 1 and 2 rely on mature temporal libraries where domain complexity (DST rules, holiday calendars, ISO 8601 edge cases) is already solved. Layer 3 implements estimation algorithms natively in both languages because the LLM-specific adaptations — particularly the five cost drivers in the COCOMO adaptation and the probabilistic confidence intervals — are not available in any existing library. The PERT and story-point tools are intentionally stateless: they accept all required data as parameters and return complete results, enabling the LLM to invoke them without maintaining server-side session state.

### 6.3 Testing and Validation

#### 6.3.1 MCP Inspector for Interactive Validation

The MCP Inspector (`npx @modelcontextprotocol/inspector`) is the official browser-based development tool for testing and debugging MCP servers. ^11^It connects via stdio, SSE, or Streamable HTTP, lists available tools with their schemas, enables individual tool invocation with custom parameters, and displays protocol frames for debugging. For a time estimation server, the Inspector workflow is: start the server, connect the Inspector, verify `tools/list` returns all estimation tools, test each tool with sample inputs, and inspect error responses. ^11^A critical security consideration is CVE-2025-49596, a remote code execution vulnerability in older Inspector versions. ^67^Always use the latest version; for testing untrusted servers, run the Inspector in a container or VM. The Inspector shows protocol messages but not internal server state, so it must be paired with stderr-based logging for full observability. ^14^#### 6.3.2 Automated Testing with pytest

The Python SDK provides `ClientSession` and `stdio_client` for building programmatic test clients. ^18^The testing strategy for a time estimation server follows three levels: unit tests for pure estimation functions (PERT math, duration parsing), integration tests using `ClientSession` against a running server, and Inspector-based smoke tests before deployment. ^18^The pytest harness below demonstrates mock `ClientSession` testing for Layer 1 and Layer 3 tools. It uses `pytest-asyncio` for async test support and launches the server as a subprocess, communicating over stdin/stdout pipes.

```python
# tests/test_server.py — pytest automated testing harness

import pytest
import asyncio
import json
import subprocess
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER_CMD = ["uv", "run", "python", "time_estimate_server.py"]

@pytest.fixture
async def session():
    params = StdioServerParameters(command=SERVER_CMD[0], args=SERVER_CMD[1:])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session

@pytest.mark.asyncio
async def test_tools_list(session):
    tools = await session.list_tools()
    names = [t.name for t in tools.tools]
    assert "get_current_time" in names
    assert "pert_estimate" in names
    assert "story_point_forecast" in names
    assert "add_business_days" in names

@pytest.mark.asyncio
async def test_pert_calculation(session):
    result = await session.call_tool("pert_estimate", arguments={
        "optimistic": 4,
        "most_likely": 8,
        "pessimistic": 16,
        "unit": "hours"
    })
    text = result.content[0].text
    data = json.loads(text)
    assert data["expected"] == 8.67   # (4 + 4*8 + 16) / 6
    assert data["std_deviation"] == 2.0
    assert data["confidence_95"] == 12.67

@pytest.mark.asyncio
async def test_domain_error_invalid_timezone(session):
    result = await session.call_tool("get_current_time", arguments={
        "timezone": "NotA_Real/Zone"
    })
    text = result.content[0].text
    data = json.loads(text)
    assert data.get("isError") is True
    assert "Invalid timezone" in data["message"]

@pytest.mark.asyncio
async def test_story_point_forecast(session):
    result = await session.call_tool("story_point_forecast", arguments={
        "backlog_points": 120,
        "velocity_history": [28, 32, 30, 35, 29],
        "sprint_length_days": 14,
        "hours_per_sprint": 320,
    })
    data = json.loads(result.content[0].text)
    assert data["average_velocity"] == 30.8
    assert data["required_sprints"] == pytest.approx(3.9, 0.1)
    assert "completion_days" in data
```

#### 6.3.3 Evaluation Harness: 10+ Complex Evaluation Questions

The mcp-builder skill from Anthropic defines a four-phase workflow for building MCP servers, with Phase 4 dedicated to creating evaluations. ^13^Academic evaluation frameworks such as MCPBench measure accuracy, time consumption, and token consumption across standardized prompts. ^109^For a time estimation server, evaluation must go beyond protocol compliance to verify that the server produces estimates that are accurate, actionable, and properly structured for LLM consumption.

The evaluation harness below defines 12 complex evaluation questions that satisfy six criteria: independent (each tests a distinct capability), read-only (no side effects), complex (multi-step reasoning), realistic (derived from actual developer scenarios), verifiable (expected answers can be computed independently), and stable (results do not depend on external state or current time). ^109^```python
# tests/evaluation_harness.py — comprehensive evaluation suite

import json
import asyncio
from dataclasses import dataclass
from typing import List
from test_server import session  # Reuses the ClientSession fixture

@dataclass
class EvalCase:
    id: str
    tool: str
    arguments: dict
    expected_keys: List[str]
    validator: callable   # function(result_dict) -> bool
    description: str

EVALUATION_SUITE = [
    EvalCase(
        id="E01",
        tool="get_current_time",
        arguments={"timezone": "UTC"},
        expected_keys=["iso", "human", "timezone", "utc_offset"],
        validator=lambda d: d["timezone"] == "UTC" and "T" in d["iso"],
        description="Basic current-time retrieval with IANA timezone",
    ),
    EvalCase(
        id="E02",
        tool="convert_timezone",
        arguments={"timestamp": "2026-06-15T09:00:00-04:00", "target_tz": "Europe/Berlin"},
        expected_keys=["original", "converted", "target_tz"],
        validator=lambda d: "15:00:00" in d["converted"] or "14:00:00" in d["converted"],
        description="DST-aware timezone conversion (EDT to CEST)",
    ),
    EvalCase(
        id="E03",
        tool="parse_duration",
        arguments={"duration_string": "P3DT12H30M"},
        expected_keys=["input", "total_seconds", "human"],
        validator=lambda d: d["total_seconds"] == 309_900,
        description="ISO 8601 duration parsing with mixed units",
    ),
    EvalCase(
        id="E04",
        tool="add_business_days",
        arguments={"start_date": "2026-12-23", "days": 5, "country": "US"},
        expected_keys=["start", "days_added", "result", "country"],
        validator=lambda d: d["result"] > "2026-12-30",  # Must skip Christmas
        description="Holiday-aware business-day addition (Christmas 2026)",
    ),
    EvalCase(
        id="E05",
        tool="count_business_days",
        arguments={"start_date": "2026-01-01", "end_date": "2026-01-15", "country": "US"},
        expected_keys=["start", "end", "business_days", "country"],
        validator=lambda d: d["business_days"] == 10,  # 15 days - New Year - 2 weekends
        description="Business-day count across New Year's holiday",
    ),
    EvalCase(
        id="E06",
        tool="pert_estimate",
        arguments={"optimistic": 2, "most_likely": 5, "pessimistic": 14, "unit": "days"},
        expected_keys=["expected", "variance", "std_deviation", "confidence_95", "confidence_99"],
        validator=lambda d: d["expected"] == 6.0 and d["std_deviation"] == 2.0,
        description="PERT Beta distribution with 95%/99% confidence bounds",
    ),
    EvalCase(
        id="E07",
        tool="pert_estimate",
        arguments={"optimistic": 10, "most_likely": 5, "pessimistic": 8, "unit": "hours"},
        expected_keys=["isError", "message"],
        validator=lambda d: d.get("isError") is True,
        description="Domain error on invalid PERT ordering (optimistic > most_likely)",
    ),
    EvalCase(
        id="E08",
        tool="story_point_forecast",
        arguments={"backlog_points": 100, "velocity_history": [20, 22, 18, 24, 21],
                     "sprint_length_days": 14, "hours_per_sprint": 280},
        expected_keys=["required_sprints", "hours_per_point", "completion_days"],
        validator=lambda d: 4.0 <= d["required_sprints"] <= 5.5,
        description="Velocity-based forecast with 5-sprint historical data",
    ),
    EvalCase(
        id="E09",
        tool="story_point_forecast",
        arguments={"backlog_points": 50, "velocity_history": [], "sprint_length_days": 14},
        expected_keys=["isError", "message"],
        validator=lambda d: d.get("isError") is True and "velocity_history" in d["message"].lower(),
        description="Error on empty velocity history — graceful failure",
    ),
    EvalCase(
        id="E10",
        tool="cocomo_llm_estimate",
        arguments={"kloc": 10.0, "reasoning_complexity": 1.2, "context_completeness": 0.9,
                   "transformation_impact": 1.0, "iterative_cycles": 1.3, "human_oversight": 0.8},
        expected_keys=["person_months_nominal", "person_months_llm_adjusted", "effort_multipliers"],
        validator=lambda d: d["person_months_llm_adjusted"] < d["person_months_nominal"],
        description="LLM-adjusted COCOMO with all 5 cost drivers applied",
    ),
    EvalCase(
        id="E11",
        tool="parse_duration",
        arguments={"duration_string": "3 business days"},
        expected_keys=["isError", "message"],
        validator=lambda d: d.get("isError") is True,
        description="Error on unsupported natural-language pattern (business days in duration parser)",
    ),
    EvalCase(
        id="E12",
        tool="add_business_days",
        arguments={"start_date": "2026-04-01", "days": 10, "country": "FR"},
        expected_keys=["result", "country"],
        validator=lambda d: "2026-04-" in d["result"] and d["country"] == "FR",
        description="French business-day calendar (Easter Monday handling)",
    ),
]

async def run_evaluation(session, suite: List[EvalCase]) -> dict:
    passed, failed = 0, 0
    results = []
    for case in suite:
        try:
            response = await session.call_tool(case.tool, arguments=case.arguments)
            text = response.content[0].text
            data = json.loads(text)

            # Check expected keys present
            keys_ok = all(k in data for k in case.expected_keys)
            # Run custom validator
            val_ok = case.validator(data) if keys_ok else False

            if keys_ok and val_ok:
                passed += 1
                results.append({"id": case.id, "status": "PASS", "desc": case.description})
            else:
                failed += 1
                results.append({"id": case.id, "status": "FAIL", "desc": case.description,
                               "keys_ok": keys_ok, "val_ok": val_ok, "data": data})
        except Exception as e:
            failed += 1
            results.append({"id": case.id, "status": "ERROR", "desc": case.description, "error": str(e)})

    return {"passed": passed, "failed": failed, "total": len(suite),
            "accuracy": round(passed / len(suite) * 100, 1), "details": results}

# Entry point for CI execution
if __name__ == "__main__":
    async def main():
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client
        params = StdioServerParameters(command="uv", args=["run", "python", "time_estimate_server.py"])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                report = await run_evaluation(session, EVALUATION_SUITE)
                print(json.dumps(report, indent=2))
    asyncio.run(main())
```

#### 6.3.4 Metrics and Benchmarks

The evaluation suite above produces a quantitative accuracy score: the percentage of evaluation cases that pass both key presence and custom validation. Based on the MCPBench finding that MCP server accuracy varies widely — from 10% (DuckDuckGo) to 64% (Bing Web Search) — and the CData benchmark showing a 25-percentage-point gap between well-designed and poorly-designed connectivity layers, the following targets are established for the Time Estimation MCP Server. ^109^ ^110^| Metric | Target | Measurement Method | Rationale |
|---|---|---|---|
| Evaluation accuracy | > 80% | 12-case automated harness | MCPBench shows 64% is achievable for web search; time estimation is a narrower domain with deterministic algorithms, so 80% is conservative ^109^|
| Average tool-call latency | < 500 ms | Median over 100 calls | Pure computation tools should complete in < 500 ms; external API calls (Jira, Toggl) may exceed this but should be cached |
| Token footprint per request | < 500 tokens | Tool definitions + response | Registry dispatch keeps tool definitions under 500 tokens; responses are JSON objects of 50–200 tokens ^21^|
| Tool selection precision | > 90% | LLM correctly chooses tool in test prompts | Augmented tool descriptions improve agent efficiency; precision is measured by whether the LLM invokes the right tool on first attempt ^97^|
| Error recovery rate | > 95% | Domain errors with retry guidance | With `isError: true` and actionable messages, the LLM should successfully retry > 95% of recoverable errors ^12^|
| Evaluation question count | >= 10 | Independent test cases | The MCPBench framework evaluates across standardized prompts; 12 cases cover 6 distinct tool families with positive and negative tests ^109^|

The 80% accuracy target is intentionally conservative. The algorithms implemented in Layers 1 and 2 (timezone conversion, business-day arithmetic, ISO 8601 parsing) are deterministic and should score near 100%. Layer 3 estimation introduces uncertainty — the PERT expected value is a weighted average, not a ground-truth oracle — so validation checks structural correctness rather than absolute accuracy. The CData benchmark demonstrated that "the connectivity layer between prompt and data source is where accuracy is determined," meaning that well-formed tool descriptions and schemas are as important as correct algorithms. ^110^At 75% per-step accuracy across a 5-step workflow, fewer than 24% of processes complete correctly; therefore, each individual tool must exceed 90% precision to yield reliable multi-step results. ^110^For continuous integration, the evaluation harness should run on every commit. The pytest suite validates functional correctness; the evaluation harness validates LLM-facing behavior. Together they ensure that changes to estimation algorithms, error messages, or response schemas do not degrade the server's ability to serve as an external time-reasoning module for AI agents. The MCP ecosystem reached 97 million monthly SDK downloads and 10,000+ public servers by March 2026; a time estimation server that passes this evaluation framework can reliably join that ecosystem. ^91^---

# 7. Integration with Coding Agents and IDEs

The Time Estimation MCP Server delivers value only when it is reachable from the coding agents and frameworks developers use daily. This chapter maps the integration pathways from the server implementation in Chapter 6 to every major coding agent, IDE, and agent framework. The Model Context Protocol has become the de facto standard — 97 million monthly SDK downloads and 10,000+ public servers confirm its dominance ^91^— meaning a single server build can serve Claude Code, Cursor, VS Code, Windsurf, Cline, and other clients with only configuration-level differences ^2^. Each client introduces its own configuration syntax, transport preferences, tool limits, and security posture. Agent frameworks such as LangChain, AutoGen, LlamaIndex, and the OpenAI Agents SDK do not speak MCP natively; they require adapter layers or decorator-based wrappers. Finally, every integration must confront the same scarce resource: the LLM's context window. A poorly integrated server can consume 26% of available tokens before any real work begins ^21^. This chapter addresses three questions: how to configure each client (§7.1), how to bridge each framework (§7.2), and how to keep the integration lightweight (§7.3).

### 7.1 MCP Client Configuration Patterns

MCP follows a strict host-client-server architecture: the host (Claude Code, Cursor, VS Code) creates one MCP client per connected server, and each client maintains a dedicated one-to-one connection ^47^. The protocol supports stdio for local execution (~1 ms latency, no authentication) and Streamable HTTP for remote services (10–100 ms latency, OAuth 2.1 support) ^100^. Because the protocol is open, the same server binary works across all compatible clients; only the host-side configuration file changes ^2^. The subsections below document the exact configuration syntax, transport defaults, and practical limits for each major client.

#### 7.1.1 Claude Code: `claude mcp add-json` with `.mcp.json` configuration; stdio transport for local execution

Claude Code offers the most sophisticated MCP configuration system of any CLI agent, with three scopes — project, local, and user — controlled by where the configuration lives ^8^. Project-scoped servers are declared in `.mcp.json` at the repository root; this file can be committed to version control. Local-scoped servers live in `~/.claude.json` and apply only to the current project on the current machine. User-scoped servers also live in `~/.claude.json` but apply globally across all projects.

For scripted setup, the `claude mcp add-json` command accepts raw JSON directly ^3^:

```bash
claude mcp add-json time-estimator \
  '{"type":"http","url":"https://api.time-estimator.dev/mcp"}'
```

For local stdio execution — recommended for development because it avoids network latency — the syntax is:

```bash
claude mcp add --transport stdio time-estimator \
  -- python -m time_estimator_server
```

Claude Code also implements Anthropic's Tool Search feature, which dynamically loads only the tool definitions needed for each task. This reduces context consumption from roughly 72,000 tokens to about 8,700 tokens — an 85% reduction — and improves tool selection accuracy from 49% to 74% on Opus 4 ^6^. Tool Search requires Sonnet 4 or later, or Opus 4 or later, and is enabled by default. For the Time Estimation MCP Server, Tool Search is the critical enabler: the server's tool definitions are loaded only when the agent is reasoning about time or effort, rather than on every prompt.

#### 7.1.2 Cursor: `.cursor/mcp.json` configuration; UI-based MCP marketplace

Cursor supports MCP through project-level `.cursor/mcp.json` or global `~/.cursor/mcp.json`, both using the same JSON schema ^12^. Cursor's integrated MCP marketplace provides UI-based discovery, though manual configuration remains necessary for custom or self-hosted servers.

A critical constraint is the recommended limit of approximately 40 active tools across all connected servers ^12^. Beyond this threshold, tool selection accuracy degrades as the context window fills with definitions. The Time Estimation MCP Server should therefore present a minimal surface — ideally one to three tools — when targeting Cursor users.

Security is another Cursor-specific concern. CVE-2025-54136 ("MCPoison") revealed that Cursor pinned trust to the MCP server's key name in the configuration file rather than to the actual command being executed ^12^. Production Cursor deployments should use absolute binary paths and restricted permissions.

#### 7.1.3 VS Code: `.vscode/mcp.json` with extensions panel; host-client-server model

VS Code implements the full MCP specification and offers the most flexible integration surface of any IDE ^5^. Servers can be added through: (a) web install URLs using `vscode:mcp/install?...` deeplinks; (b) workspace configuration in `.vscode/mcp.json`; (c) global user-profile configuration; (d) autodiscovery from Claude Desktop; (e) extensions registering servers programmatically via `vscode.lm.registerMcpServerDefinitionProvider`; or (f) command-line setup with `--add-mcp` ^5^ ^9^.

The workspace-scoped `.vscode/mcp.json` is the pattern most teams should adopt, because it makes the server available automatically to anyone who opens the project. VS Code's host-client-server model aligns exactly with the MCP architecture: the Copilot Chat extension acts as the host, creates an MCP client, and maintains a stdio connection to the server process. Because VS Code also supports autodiscovery from Claude Desktop, developers who already configured the server in Claude Code will find it available in VS Code by enabling `"chat.mcp.discovery.enabled": true` ^111^.

#### 7.1.4 Windsurf, Cline, Roo Code, Continue.dev, Gemini CLI: configuration syntax variations and best practices

The remaining major clients each introduce a configuration dialect that server documentation must address.

**Windsurf** provides a built-in MCP Marketplace with one-click installation via `windsurf://windsurf-mcp-registry?serverName=...` deeplinks ^14^. It supports all three transports and enforces a 100-tool total limit per Cascade session ^14^. Configuration on macOS lives at `~/.codeium/windsurf/mcp_config.json` ^11^.

**Cline** supports natural-language MCP server building: pasting a GitHub repository URL causes Cline to clone, build, and register the server automatically ^17^. Network timeout is configurable from 30 seconds to 1 hour, which matters for tools that analyze large codebases ^18^.

**Roo Code** can auto-generate MCP servers from natural language prompts ^16^. For pre-built servers, Roo consumes VS Code's MCP settings and allows disabling MCP servers to remove all MCP-related logic from the system prompt, reducing token usage ^16^.

**Continue.dev** is the outlier: it uses YAML configuration files in `.continue/mcpServers/` rather than JSON ^19^ ^20^.

**Gemini CLI** follows a pattern nearly identical to Claude Code's: `gemini mcp add --transport http time-estimator https://api.time-estimator.dev/mcp/` ^112^. Configuration lives in `~/.gemini/settings.json`, with OAuth 2.0 for authenticated endpoints ^113^.

**Aider** is the notable exception. It connects directly to LLM APIs and does not implement MCP ^42^ ^21^. Aider users who want time estimation must either call a standalone CLI wrapper before invoking Aider, use the tool as a pre-processing step, or integrate at the LLM API layer via custom function calling.

Table 1 consolidates the configuration patterns, transport support, and tool limits for every client discussed above.

| Client | Config File / Command | Transports | Tool Limit | Scope | Key Constraint |
|---|---|---|---|---|---|
| Claude Code | `claude mcp add-json`; `.mcp.json` | stdio, HTTP, SSE | ~100 with Tool Search ^6^| project / local / user | Tool Search requires Sonnet 4+ |
| Cursor | `.cursor/mcp.json` | stdio, HTTP, SSE | ~40 recommended ^12^| project / global | CVE-2025-54136 path trust |
| VS Code + Copilot | `.vscode/mcp.json`; `--add-mcp` | stdio, HTTP, SSE | N/A | workspace / global / extension | Autodiscovery from Claude Desktop ^111^|
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | stdio, HTTP, SSE | 100 total ^14^| global / marketplace | Deeplink one-click install |
| Cline | `.clinerules/` or UI | stdio, HTTP, SSE | N/A | project | 30s–1h timeout configurable ^18^|
| Roo Code | VS Code MCP settings | stdio, HTTP, SSE | N/A | project | Auto-generation from natural language ^16^|
| Continue.dev | `.continue/mcpServers/*.yaml` | stdio, SSE, streamable-http | N/A | workspace | YAML syntax ^19^|
| Gemini CLI | `~/.gemini/settings.json`; `gemini mcp add` | stdio, SSE, HTTP | N/A | global | OAuth 2.0 support ^113^|
| Aider | N/A (no MCP support) ^42^| N/A | N/A | N/A | Requires CLI wrapper or pre-processing |

The table reveals two structural patterns. First, JSON-based configuration dominates six of eight MCP-capable clients, with Continue.dev's YAML and Gemini CLI's settings JSON as exceptions. Documentation should lead with JSON and provide YAML as a secondary format. Second, tool limits vary by an order of magnitude: Cursor's ~40-tool ceiling is the tightest constraint, while Windsurf's 100-tool limit and Claude Code's Tool Search effectively remove the limit. A server targeting universal compatibility should expose no more than three discrete tools, consolidating related operations behind parameters rather than separate endpoints.

### 7.2 Agent Framework Integration

Coding agents and IDEs consume MCP servers directly. Agent frameworks — LangChain, AutoGen, LlamaIndex, OpenAI Agents SDK — do not. They provide their own abstractions for tool definition, binding, and execution, and an MCP server must be wrapped or bridged to fit each. The subsections below document the exact integration pattern for each framework.

#### 7.2.1 LangChain: `@tool` decorator + `model.bind_tools()` pattern for tool binding

LangChain's tool integration centers on the `@tool` decorator, which wraps a Python function with automatic schema inference from type hints and docstrings, and on `model.bind_tools(tools)`, which attaches the tool set to a chat model ^15^ ^43^. A ReAct agent built in LangGraph follows a think-act-observe loop: the model receives the user query, reasons about which tool to call, executes it, observes the result, and repeats until the task completes ^69^.

For the Time Estimation MCP Server, there are two integration paths. The first is to wrap the MCP server's tools as LangChain `@tool` functions using an MCP client library. The second — simpler for teams already using LangChain — is to implement the estimation logic as a native `@tool` and bypass MCP entirely. The `@tool` docstring is critical: it is what the LLM "reads" to decide when to invoke the function. For time estimation, the docstring must explicitly mention "time," "duration," "effort," or "estimate" so that the model recognizes the tool's relevance to planning queries ^44^.

#### 7.2.2 AutoGen: `McpWorkbench` + `StreamableHttpServerParams` for multi-agent coordination

Microsoft's AutoGen framework supports MCP through `autogen-ext-tools` and the `McpWorkbench` class ^13^. The pattern is to instantiate `StreamableHttpServerParams` with the server URL and credentials, wrap it in a `McpWorkbench` context manager, and pass the workbench to an `AssistantAgent`:

```python
from autogen_ext.tools.mcp import McpWorkbench, StreamableHttpServerParams

server_params = StreamableHttpServerParams(
    url="https://api.time-estimator.dev/mcp",
    timeout=30.0,
    sse_read_timeout=300.0,
    headers={"x-api-key": os.getenv("TIME_ESTIMATOR_API_KEY")}
)

async with McpWorkbench(server_params) as workbench:
    agent = AssistantAgent(
        name="estimator_planner",
        model_client=model_client,
        workbench=workbench,
        max_tool_iterations=10
    )
```

The `McpWorkbench` pattern is particularly powerful for multi-agent coordination because multiple AutoGen agents can share the same MCP server connection. A planner agent can call the time estimation tool to build a schedule, a coder agent can re-estimate after discovering complexity, and a reviewer agent can validate deadlines — all through the same workbench instance ^13^.

#### 7.2.3 LlamaIndex: `FunctionTool.from_defaults()` for query engine integration

LlamaIndex provides `FunctionTool.from_defaults(fn, name=...)` to wrap any Python callable as an agent-accessible tool ^44^ ^46^. The Hugging Face Agents Course emphasizes that "defining a clear set of Tools is crucial to performance... clear tool interfaces are easier for LLMs to use" ^44^. This is especially true in LlamaIndex, where tools are often composed into query engines that chain multiple retrieval and computation steps. The `name` and `description` parameters are what the LLM sees; they should be specific and action-oriented. A generic name like "time_tool" is less likely to be selected than "estimate_task_time" when the agent is reasoning about project planning ^114^.

#### 7.2.4 OpenAI Agents SDK: `activity_as_tool` helper for tool registration

The OpenAI Agents SDK (formerly Assistants API) uses function calling with JSON Schema metadata: the developer defines the tool's name, description, and input schema, and the LLM decides when to request invocation ^47^. The actual execution happens on the client side, not within OpenAI's infrastructure. The `activity_as_tool` helper bridges this pattern by converting an activity definition into a tool binding compatible with the Agents SDK runtime.

For the Time Estimation MCP Server, the integration requires an OpenAI-compatible client wrapper that translates between the MCP protocol and the Agents SDK's function-calling format. The wrapper exposes the server's tool definitions as JSON Schema and routes the LLM's function-call requests to the MCP server via HTTP.

Table 2 compares the four frameworks on integration pattern, transport handling, multi-agent support, and the specific class or decorator responsible for tool binding.

| Framework | Integration Pattern | Transport Handling | Multi-Agent Support | Tool Binding Primitive | MCP Native |
|---|---|---|---|---|---|
| LangChain / LangGraph | `@tool` decorator + `bind_tools()` | Client-managed (stdio/SSE/HTTP via adapter) | Yes, via LangGraph state machine | `model.bind_tools(tools)` ^15^| Via adapter |
| AutoGen | `McpWorkbench` context manager | `StreamableHttpServerParams` ^13^| Yes, shared `workbench` across agents | `AssistantAgent(workbench=...)` ^13^| Yes, via `autogen-ext-tools` |
| LlamaIndex | `FunctionTool.from_defaults()` | Client-managed via transport wrapper | Yes, via `QueryEngineTool` chaining | `FunctionTool.from_defaults(fn)` ^44^| Via wrapper |
| OpenAI Agents SDK | JSON Schema function calling | HTTP/SSE client wrapper | Yes, via agent orchestration | `activity_as_tool` helper | Via wrapper |

The comparison reveals that only AutoGen offers first-class, native MCP integration through `McpWorkbench`; the other three frameworks require adapter or wrapper layers. For production deployments, this means teams should budget implementation time for the wrapper layer, or they should choose AutoGen if MCP-native consumption is a hard requirement. All four frameworks share a common design principle: the tool's name and description are the interface the LLM reasons about, and their clarity directly determines selection accuracy ^44^ ^114^.

**Integration architecture diagram.** Figure 7.1 depicts the complete integration topology. At the center, the Time Estimation MCP Server exposes a Streamable HTTP endpoint (or stdio for local use) with a registry-based dispatch layer (see §7.3.1). On the left, MCP-native clients — Claude Code, Cursor, VS Code, Windsurf, Cline, Gemini CLI — connect directly via their respective MCP client implementations, each using the host-client-server model. On the right, agent frameworks connect through adapter layers: AutoGen's `McpWorkbench` consumes the server natively; LangChain, LlamaIndex, and the OpenAI Agents SDK each use a thin wrapper translating between MCP protocol messages and the framework's internal tool representation. A Supergateway bridge ^115^sits between local stdio servers and remote HTTP consumers. All connections converge on the same server binary, validating MCP's "build once, use everywhere" value proposition ^2^.

### 7.3 Context Window Optimization

Every tool definition loaded into an MCP client consumes tokens from the context window before any user prompt is processed. For a time estimation server, the challenge is twofold: schemas must be descriptive enough for correct selection, yet compact enough to avoid crowding out code, conversation history, and reasoning traces.

#### 7.3.1 Token footprint reduction: 11 tools at ~3,150 tokens (Harness v2 pattern) vs 175 tools at ~26% context window

The Harness engineering team documented the most influential case study in MCP context optimization. Their first server exposed 130+ individual tools and consumed roughly 26% of a 200,000-token context window ^21^. Their v2 redesign consolidated these into 11 registry-dispatched tools, cutting consumption to approximately 1.6% ^21^. The key insight was to separate *what* the LLM wants to do from *how* the server executes it: the LLM selects a generic operation and provides a resource type parameter; the server looks up the type in an internal registry and dispatches to the correct endpoint.

For the Time Estimation MCP Server, this pattern translates directly. Rather than exposing separate tools for `estimate_simple_task`, `estimate_complex_task`, `estimate_with_history`, and so on, the server should expose a single `estimate_time` tool with a `mode` or `method` parameter. The token savings are substantial: GitHub's official MCP server consumes 17,600 tokens of tool definitions per request, and connecting multiple servers can push pre-work metadata to 30,000+ tokens ^96^. Atlassian's `mcp-compressor` proxy demonstrates that aggressive schema compression can reduce this by up to 97%, but over-compression hurts tool selection accuracy ^96^.

The practical target for the Time Estimation MCP Server should be under 500 tokens for all tool definitions combined. A single tool with a clear name, a one-sentence description, and a compact JSON Schema for five to seven parameters typically lands in the 250–400 token range ^4^.

#### 7.3.2 Tool Search annotation (Anthropic): reduces context consumption by ~85% (72K → 8.7K tokens)

Anthropic's Tool Search, available in Claude Code and Claude Desktop, changes the optimization equation entirely. Instead of loading all tool definitions from all connected servers on every turn, Tool Search indexes the available tools and loads only those whose descriptions match the current task ^6^. The measured reduction is from ~72,000 tokens to ~8,700 tokens — an 85% reduction ^6^. Tool selection accuracy improves simultaneously, from 49% to 74% on Opus 4 ^6^.

Tool Search is not universal. Cursor, VS Code (as of mid-2026), and the agent frameworks lack equivalent mechanisms. The recommended dual strategy is: (a) design for the lowest-common-denominator client (Cursor's ~40-tool ceiling) so the server is universally lightweight; and (b) take advantage of Tool Search in Claude Code by providing rich, searchable tool descriptions.

A competing approach, Stacklok's MCP Optimizer, claims 94% tool selection accuracy versus Anthropic's Tool Search at 34% when tested against 2,792 tools ^114^. The discrepancy likely stems from different test methodologies — Stacklok uses semantic embeddings, while Tool Search relies on description keyword indexing. For a small server with three or fewer tools, the difference is negligible.

#### 7.3.3 Progressive disclosure: summary information by default, detailed exploration on request

Even with compact tool definitions, the *output* of a time estimation tool can bloat the context window on subsequent turns. A detailed PERT analysis with optimistic, pessimistic, and most-likely estimates, confidence intervals, historical comparisons, and risk factors can easily return 2,000–3,000 tokens of structured JSON. When this output is fed back into the context as a tool result, it consumes space that could otherwise hold code, conversation history, or reasoning traces.

The progressive disclosure pattern addresses this by returning a minimal summary by default and exposing a separate tool (or a `detail_level` parameter) for full exploration. The default response should be a single sentence — "Estimated 2.5 hours (medium confidence)" — perhaps 20–30 tokens. If the agent needs the full breakdown, it invokes the tool again with `detail_level: "full"`.

This pattern also aligns with the finding that qualitative, categorical time signals are more actionable for LLMs than precise numeric countdowns ^6^. A categorical summary ("short task — under 1 hour," "medium — 1–4 hours," "large — over 4 hours") is both more compact and more legible to the LLM than a floating-point hour estimate. The LLM should *request* time calculations, not *perform* them; the server should provide structured, categorical outputs that the LLM can reason about without arithmetic.

Production agents need explicit budget guardrails: loop limits, tool-call caps, token budgets, wall-clock timeouts, and tenant budgets ^64^. A well-designed agent "has a budget contract the way a well-run service has an SLO" ^64^. The Time Estimation MCP Server should be engineered to never trigger these guardrails: responses should be sub-second, outputs should be compact, and the server should be stateless so it can be called repeatedly without accumulating session state. Claude Code's own token budget system uses three mechanisms — hard internal limits, automatic context compaction, and pre-execution budget checks — with compaction reducing context size by 60–80% on long-running sessions ^116^. By keeping both schema and output minimal, the Time Estimation MCP Server ensures it is a net contributor to agent capability rather than a net consumer of context budget.


---

# 8. Evaluation, Quality Assurance, and Production Deployment

A time-estimation MCP server that produces inaccurate or insecure results is worse than no server at all. This chapter defines the evaluation framework, security posture, and deployment patterns required to move from prototype to production.

### 8.1 Evaluation Framework

#### 8.1.1 Accuracy Metrics for Duration Prediction and Software Effort Estimation

Evaluating a time-estimation tool requires metrics from two disciplines: statistical forecasting and software engineering.

For point forecasts, the Mean Absolute Error ($\text{MAE}$) is the standard metric for median estimation goals because it is robust to outliers ^8^. The Mean Absolute Percentage Error ($\text{MAPE}$) is common in practice but becomes numerically unstable when actual durations approach zero ^3^— a concern where quick fixes coexist with multi-hour refactoring. The Root Mean Squared Error ($\text{RMSE}$) is preferable when large misses must be penalized more heavily, but it is scale-sensitive ^8^.

For software effort estimation, the literature converges on Mean Magnitude of Relative Error ($\text{MMRE}$) and PRED(25), the percentage of estimates within 25% of actual. A systematic review of twenty-eight primary studies establishes MMRE $\leq 0.25$ as the acceptable threshold for production models ^6^. Ensemble techniques consistently outperform solo techniques by 10–15% on both metrics ^6^, directly supporting the multi-heuristic architecture from preceding chapters. A time-estimation server should report confidence intervals alongside point estimates — a range ("2–4 hours, 80% confidence") is more actionable than a single number.

#### 8.1.2 MCP-Specific Metrics: Task Completion Speed and Tool Reliability

Beyond raw accuracy, the MCP ecosystem has developed operational metrics that capture how effectively an agent uses external tools. The Twilio MCP-TE Benchmark evaluates AI coding agents under a rigorous Control-vs.-Treatment methodology, measuring Duration, API Calls, Interactions, Tokens, Cache activity, Cost, and Success Rate ^2^. In controlled tests with Claude 3.7 Sonnet, MCP-enabled agents reduced average task duration from 62.54 seconds to 49.68 seconds ($-20.56$%) and API calls from 10.27 to 8.29 ($-19.26$%), while pushing success rate from 92.31% to 100% ^2^. These figures establish the performance envelope a well-designed server should target.

Production observability frameworks define three metric tiers ^1^: performance/reliability, resource efficiency, and application-specific quality. Within this taxonomy, four agent-specific metrics are particularly relevant. Task Success Rate (TSR) should reach 85–95% for mature systems ^1^. Turns-to-Completion (TTC) has an optimal range of 2–5 turns; tasks requiring more than seven turns exhibit 60% higher abandonment rates ^1^. Tool Hallucination Rate — the frequency of invalid tool invocations — should stay between 2% and 8% ^1^. Self-Correction Rate, the proportion of failed calls successfully retried, should reach 70–80% ^1^. A server that produces malformed duration strings will directly degrade these metrics.

#### 8.1.3 Temporal Reasoning Benchmarks: Academic Validation Standards

Academic benchmarks prevent overfitting to internal test suites. TimeBench covers ten tasks across symbolic, commonsense, and event temporal reasoning ^4^. GPT-4 ranked first in sixteen of nineteen metrics and outperformed GPT-3.5 by 14.7%, yet still exhibits a 19% gap from human performance ^4^. Even the best model fails on roughly one in five temporal questions that humans handle correctly.

Google's "Test of Time" benchmark isolates memorization from reasoning ^10^. LLMs show stable performance on duration calculations — suggesting true algorithmic competence — but day-of-week performance drops dramatically for dates beyond 2050, revealing reliance on memorized patterns ^10^. Duration estimation is reasoning-stable; calendar lookups should be delegated to deterministic tools.

TempoBench evaluates multi-step temporal and causal reasoning with formally verifiable ground truth ^5^. The KAIST framework achieved a 21.7% improvement in detecting temporal hallucinations ^9^. Most relevant to deployment, the TicToc benchmark reveals "temporal blindness": without timestamps, models perform near-random (marginally exceeding 55% alignment); with timestamps, the best models peak below 65% ^12^. Post-training with Direct Preference Optimization shows massive improvement potential, but as of early 2026 no model has crossed the 65% threshold ^12^.

**Table 8.1: Evaluation Metrics Summary for Time-Estimation MCP Servers**

| Metric Category | Metric | Formula / Definition | Target Threshold | Primary Use Case |
|---|---|---|---|---|
| Statistical forecasting | MAE | $\frac{1}{n} \sum |\hat{y}_i - y_i|$ | Minimize; scale-dependent | Median duration estimation ^8^|
| Statistical forecasting | MAPE | $\frac{100}{n} \sum |\frac{y_i - \hat{y}_i}{y_i}|$ | $< 25\%$ for stable values | Relative error comparison ^3^|
| Statistical forecasting | RMSE | $\sqrt{\frac{1}{n} \sum (\hat{y}_i - y_i)^2}$ | Minimize; penalizes large misses | Large-miss-sensitive forecasts ^8^|
| Software effort estimation | MMRE | $\frac{1}{n} \sum |\frac{\hat{y}_i - y_i}{y_i}|$ | $\leq 0.25$ | Effort model acceptability ^6^|
| Software effort estimation | PRED(25) | % of estimates within 25% of actual | $\geq 60\%$ | Practical usability threshold ^6^|
| MCP operational | Task Success Rate (TSR) | % of tasks completed successfully | 85–95% | Production north-star metric ^1^|
| MCP operational | Turns-to-Completion (TTC) | Median tool-call turns per task | 2–5 turns | Interaction efficiency ^1^|
| MCP operational | Tool Hallucination Rate | % of invalid tool invocations | 2–8% | Tool schema alignment ^1^|
| MCP operational | Self-Correction Rate | % of failed calls successfully retried | 70–80% | Agent resilience ^1^|
| Temporal reasoning | TimeBench overall | 19 sub-task accuracy scores | Benchmark vs. GPT-4 baseline | General temporal competence ^4^|
| Temporal reasoning | TicToc alignment | Normalized temporal alignment rate | $< 65\%$ current ceiling | Temporal blindness detection ^12^|

Table 8.1 spans three evaluation layers — statistical accuracy, operational efficiency, and reasoning validity — and no single metric is sufficient. A server with low MAE but TTC $= 12$ and TSR $= 60$% is accurate yet unusable. The recommended protocol runs all metrics in CI/CD, fails the build on threshold violations, and tracks week-over-week deltas. The Twilio MCP-TE methodology provides a ready-made harness for operational metrics ^2^, while academic benchmarks can be integrated as nightly regression tests.

### 8.2 Safety and Security Controls

#### 8.2.1 OWASP MCP Top 10: Path Traversal, Injection, and Indirect Prompt Attacks

The MCP ecosystem's rapid growth has outpaced its security maturity. A study of 2,614 implementations found that 82% use file system operations prone to Path Traversal (CWE-22), 67% to Code Injection (CWE-94), and 34% to Command Injection (CWE-78) ^15^. These are the statistical default, not edge cases. A scan of 8,000+ public servers found 36.7% with SSRF vulnerabilities, 43% with unsafe command execution, and 41% in the official registry with zero authentication ^47^. Indirect prompt injection further expands the attack surface: malicious instructions embedded in processed content trigger vulnerable tools without user intent ^46^.

OWASP has published an MCP Top 10 (v0.1) organizing these risks: Token Mismanagement; Privilege Escalation; Tool Poisoning; Supply Chain Attacks; Command Injection; Intent Flow Subversion; Insufficient Authentication; Lack of Audit and Telemetry; Shadow MCP Servers; and Context Injection ^44^. For a time-estimation server, the most relevant categories are Command Injection, Context Injection (if user descriptions are passed unescaped to downstream APIs), and Insufficient Authentication.

Production-grade servers should implement five safety controls from the Harness MCP v2 server ^45^: confirmation for writes via MCP elicitation, fail-closed deletes, read-only mode for shared environments, secrets safety (metadata only), and rate limiting with backoff. MCP tool annotations shipped in the 2025-03-26 revision provide a "risk vocabulary" (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) ^67^. The specification treats these as untrusted hints with pessimistic defaults: a tool with no annotations is assumed potentially destructive, non-idempotent, and open-world ^67^. A time-estimation server should set `readOnlyHint: true`, `destructiveHint: false`, and `idempotentHint: true` to signal safe speculative invocation.

#### 8.2.2 Authentication Patterns: API Keys, OAuth 2.0, and mTLS

Three dominant authentication patterns exist for MCP servers ^117^. API key authentication via `Authorization: Bearer <token>` is adequate for internal deployments but requires `timingSafeCompare` to prevent timing attacks ^117^. OAuth 2.0 is required for multi-tenant environments; the MCP specification mandates OAuth 2.1 for Streamable HTTP transports ^44^ ^118^. Mutual TLS (mTLS) is the pattern of choice for zero-trust environments ^117^. A layered production pattern combines all three: mTLS at transport, OAuth for user-delegated scopes, and API keys for health-check endpoints.

#### 8.2.3 Rate Limiting: Per-Session and Per-Tool Quotas

AI agents generate load patterns fundamentally different from human users. During normal operation, an agent can issue fifty or more rapid sequential tool calls as it explores a solution space ^119^. A naive per-IP rate limit designed for human consumers will throttle legitimate agent behavior or permit abusive bursts.

Effective rate limiting operates on two dimensions: per-session limits tracking individual conversations, and per-tool limits restricting expensive operations independently ^119^. The recommended JSON-RPC error response uses code `-32029` with a `retryAfter` field, allowing the agent to implement exponential backoff ^119^. Token-based quotas that limit actual compute usage (input plus output tokens) are preferable to raw request counts because they align cost with resource consumption ^119^. For a time-estimation server, per-tool limits should be strictest on external API calls (calendar services, project-management platforms) and most permissive on stateless calculations (duration arithmetic, timezone conversion).

**Table 8.2: Security Controls Checklist for Production MCP Deployment**

| Control Domain | Control | Implementation Pattern | Verification Method | Priority |
|---|---|---|---|---|
| Input validation | Schema enforcement | Pydantic / Zod with `strict_input_validation` ^64^| Fuzz test with 1,000 malformed inputs | Critical |
| Input validation | Path traversal prevention | Canonicalize paths; reject `../` sequences | Static analysis + penetration test | Critical |
| Input validation | Injection sanitization | Parameterized queries; never shell-join user input | CWE-78/94 scan (target: 0 findings) | Critical |
| Authentication | Internal / dev | API key via `Authorization: Bearer`; `timingSafeCompare` ^117^| Token replay + brute-force test | High |
| Authentication | Multi-tenant | OAuth 2.1 with PKCE; scope-limited tokens ^118^| OAuth conformance test suite | High |
| Authentication | Zero-trust | mTLS with certificate rotation ^117^| Certificate pinning verification | High |
| Authorization | Tiered approval | Auto-approve read-only (1–10 pts); multi-party for >100 pts ^68^| Role-based access matrix review | High |
| Rate limiting | Per-session | Session-keyed token bucket; 60 req/min baseline ^119^| Load test with 100 concurrent agents | High |
| Rate limiting | Per-tool | Tool-category quotas; strictest on external API calls ^119^| Monitor `retryAfter` response rate | High |
| Rate limiting | Token quota | Limit by input + output tokens, not request count ^119^| Cost-correlation audit | Medium |
| Safety controls | Write confirmation | MCP elicitation for all destructive operations ^45^| Automated workflow test | Critical |
| Safety controls | Fail-closed defaults | Return safe state on unhandled exceptions ^45^| Chaos engineering: inject random faults | High |
| Safety controls | Read-only mode | Environment-flagged read-only for shared deployments ^45^| Functional test: attempt write, verify rejection | High |
| Safety controls | Tool annotations | Set `readOnlyHint`, `destructiveHint`, `idempotentHint` ^67^| Schema validation on `tools/list` response | Medium |
| Observability | Structured logging | Log to stderr (stdio) or MCP notifications (HTTP); never stdout ^114^| Log injection test | High |
| Observability | Audit telemetry | Log every tool call with arguments hash, result code, latency ^44^| 30-day retention compliance check | High |
| Supply chain | Dependency scanning | Scan all SDK dependencies; pin to stable versions ^43^| Snyk zero-critical policy | High |
| Supply chain | SDK vulnerability | Monitor CVE feeds (e.g., CVE-2025-49596 for Inspector) ^111^| Automated CVE alerting within 24 h | Critical |

Table 8.2 distills the security analysis into an actionable checklist. Controls marked Critical address risks that are both prevalent — the 82% path-traversal rate and the systemic RCE vulnerability affecting 150 million-plus downloads ^15^ ^43^— and consequential if exploited. Each control is paired with a verification method; security posture is only as good as the tests that validate it.

### 8.3 Production Deployment Patterns

#### 8.3.1 Local Deployment: stdio Transport with Package Managers

Local deployment is the entry point for most MCP servers. The stdio transport runs the server as a child process of the host application, communicating over stdin/stdout with approximately one millisecond of round-trip latency and no authentication overhead ^120^. In Python, the canonical pattern uses `uv run` to execute the server module directly from its `pyproject.toml` definition ^116^. In TypeScript, the equivalent uses `npx` to execute a published npm package ^70^. Docker containerization provides reproducibility: a multi-stage build compiles dependencies in an isolated layer and copies only the runtime artifact into a slim final image. The stdio transport has a critical constraint: the server must never write non-JSON-RPC data to stdout, because extraneous output corrupts the protocol stream ^114^. All logging must go to stderr or to MCP's structured logging notifications.

#### 8.3.2 Remote Deployment: Streamable HTTP with Load Balancing

Remote deployment uses the Streamable HTTP transport, which replaced the deprecated SSE transport in March 2025 ^120^. Streamable HTTP uses a single endpoint with POST requests and optional SSE streaming ^120^. Latency ranges from 10–100 milliseconds, and the transport natively supports OAuth 2.1 ^120^.

For production at scale, the MCP specification recommends stateless mode for horizontal scaling ^44^. Stateless mode sacrifices server-initiated capabilities — sampling, progress notifications, and subscriptions — in exchange for perfect load-balancer compatibility ^44^. For a time-estimation server that primarily answers synchronous queries, this tradeoff is favorable. If asynchronous features are required, a hybrid architecture routes stateful sessions to pinned backends via session affinity.

Health-check endpoints should verify both the transport layer (TCP connectivity) and the application layer (a lightweight `tools/list` call confirming schema enumeration). The `mcp-proxy` utility bridges stdio servers to HTTP without code modification ^115^.

#### 8.3.3 Monitoring and Observability: Structured Logging and Telemetry

Observability must satisfy two audiences: the AI client, which needs concise results, and the human operator, which needs diagnostic detail. In stdio mode, all diagnostic output goes to stderr; in HTTP mode, the server emits JSON-RPC notifications for logging events ^114^. The cardinal rule is that stdout is reserved exclusively for the JSON-RPC protocol stream ^114^. Violating this rule produces cryptic errors because the client rejects malformed frames before they reach application-level handlers.

Tool-call duration tracking is essential for two reasons. First, the server must factor its own latency into estimates: if `estimate_task_duration` takes 400 milliseconds, that overhead should be reflected in downstream estimates. Second, duration telemetry reveals regressions. The recommended telemetry schema records: tool name, arguments hash (for privacy), timestamps, result code, and cache hit/miss status.

Estimation accuracy telemetry closes the feedback loop between prediction and reality. When a coding agent receives "3 hours, confidence 75%", the telemetry system should later record the actual wall-clock duration. This actual-vs.-estimated delta feeds the MMRE and PRED(25) metrics in Table 8.1 and provides the training signal for reference-class forecasting models. Without this closed loop, the server cannot learn from its mistakes, and the compound fracture of architectural limitation, bias replication, and methodology breakdown identified in Chapter 1 will persist indefinitely.


---

# 9. Future Directions and Strategic Recommendations

The preceding chapters established that LLM time estimation failures are not a single bug but a compound fracture: architectural statelessness prevents continuous wall-clock tracking, training data replicates human planning fallacies, and traditional software estimation models assume human labor speeds that no longer apply ^2^ ^3^. Fixing this requires coordinated action across three distinct stakeholder groups — users and developers who consume estimates today, tool builders who can close the infrastructure vacuum, and researchers who must redefine what "good" temporal reasoning means for predictive tasks. This chapter translates the findings into a prioritized action matrix with immediate, medium-term, and research horizons.

### 9.1 For LLM Users and Developers

#### 9.1.1 Immediate Mitigations

The most reliable fixes available today do not require new models or custom infrastructure; they require disciplined prompt engineering and tool delegation. Four practices should be adopted immediately.

**Date injection in system prompts.** Production deployments should anchor every session with an ISO 8601 date in the system prompt, placed before other instructions to maximize attention weight. UTC anchoring avoids timezone ambiguity, and a two-month buffer before the stated knowledge cutoff prevents edge-case rollover hallucinations ^58^. This single change eliminates the most common class of temporal staleness failures, where models treat training cutoff dates as "today."

**Explicit time-state updates at each turn.** The UPenn negotiation study demonstrated that explicit remaining-time feedback improved deal closure from 4% to 32% — a 708% relative improvement ^3^. Multi-turn agents should receive elapsed-time or remaining-time tokens at every step, not rely on the model to accumulate duration internally. Because self-attention lacks a counting mechanism, temporal state must be re-injected rather than inferred.

**Qualitative urgency cues over numeric countdowns.** Counterintuitively, the UPenn study found that qualitative urgency reminders ("Deadline approaching — act with urgency") outperformed explicit numeric countdowns ("137 seconds left") ^3^. LLMs map categorical pressure signals to policy adaptation more reliably than they perform arithmetic on continuous quantities. Production prompts should therefore include urgency classifications (e.g., *low / moderate / high / critical*) alongside any numeric time data.

**Tool use for all temporal calculations.** Every date arithmetic, duration conversion, timezone translation, or calendar lookup should be delegated to deterministic tools. Toolformer's calendar API, PAL's Python interpreter offloading, and MCP time servers all demonstrate that external execution eliminates compositional error accumulation ^7^ ^56^. Models should *request* temporal computations, not *perform* them. Even with temperature set to 0.0, GPT-4 intermittently guesses dates when explicit function calling is available ^57^, making tool delegation non-negotiable for accuracy-critical applications.

#### 9.1.2 Medium-Term Strategies

Once immediate mitigations are in place, teams should invest in three structural improvements over the next 6–12 months.

**Adopt MCP-based time estimation tools.** The Model Context Protocol ecosystem (97 million monthly SDK downloads, 10,000+ public servers) is the dominant integration standard across Claude Code, Cursor, VS Code, Windsurf, and Cline ^52^ ^51^. Existing MCP time servers (mcp-server-time, date-time-tools) provide clock and timezone primitives but stop there. The gap — no server combines clock time, calendar math, software estimation algorithms, and historical project data — represents both a current limitation and a migration path. Teams should prototype against the 5-layer Time Estimation MCP architecture described in Chapter 6, feeding it real project telemetry from day one so that reference class data accumulates before the model layer is fully mature.

**Integrate historical project management data.** Reference class forecasting outperforms parametric models when task structures are irregular, and LLM-assisted development is highly irregular. METR's "messiness" factors degrade model-based predictions by approximately 8% per point ^2^. Teams should connect estimation tools to Jira, Asana, or Toggl APIs to retrieve actual-vs-estimated durations for similar tasks. A task previously estimated at 4 hours that consistently takes 8 hours in your team's history is a more reliable predictor than any algorithmic model.

**Establish team-specific velocity baselines.** Generic LLM speed assumptions (e.g., "Claude processes 500 tokens/second") fail in practice because wall-clock time depends on reasoning depth, tool-call latency, and parallel execution. Teams should instrument their own agent sessions to build empirical token-to-time mappings under local network and API-rate conditions. This baseline transforms token budgets — the implicit but broken time proxy agents currently use — into calibrated duration forecasts.

### 9.2 For Tool Builders

#### 9.2.1 Build the Missing Infrastructure

The MCP ecosystem has servers for file systems, databases, web search, and version control. It has no integrated time estimation server. This vacuum is the single highest-impact greenfield opportunity in agent tooling.

The recommended 5-layer architecture — Core Temporal, Calendar Math, Software Estimation, Data Integration, and Advanced Analytics — fills a genuine gap, not an incremental improvement. Each layer addresses a distinct failure mode identified in the research: Core Temporal fixes the continuous-time deficit, Calendar Math delegates arithmetic, Software Estimation replaces human-centric COCOMO with LLM-aware drivers, Data Integration enables reference class forecasting, and Advanced Analytics tracks prediction error for iterative calibration. Tool builders who ship the first integrated server in this space will define the category.

Production requirements should follow the patterns validated in Chapter 8: stdio transport for local agents, HTTP/SSE for remote deployments, structured output schemas for deterministic parsing, and OWASP MCP Top 10 compliance for security (authentication, rate limiting, input validation, audit logging). The server should expose both numeric estimates and categorical classifications (*short / medium / long*; *likely / optimistic / pessimistic*) because LLMs process qualitative time pressure more reliably than quantitative values ^3^.

#### 9.2.2 Prioritize Reference Class Forecasting Over Algorithmic Purity

COCOMO, Function Points, and Story Points all assume human-labor-driven effort with predictable task structures ^2^. LLM-assisted development breaks both assumptions: reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight are five cost drivers that no traditional model captures ^2^. When METR tasks are scored for "messiness" on a 16-point scale, each additional point degrades agent performance by roughly 8%, producing exponential error growth in clean parametric models.

The tool builder's priority should therefore be PM system integration (Jira, Toggl, Asana, GitHub Projects) and historical actual-vs-estimated analysis. Algorithmic layers (PERT, Monte Carlo) serve as fallback priors when historical data is sparse, but they should not be the primary output mode. The TicToc benchmark's finding that direct preference optimization on historical temporal data yields massive alignment gains provides a post-training template for data-driven estimation models ^1^.

### 9.3 For Researchers

#### 9.3.1 Duration Estimation Benchmarks Needed

The current temporal reasoning benchmark landscape evaluates *reasoning* (event ordering, date arithmetic, duration calculation) rather than *prediction* (estimating how long a future task will take). TimeBench, TempoBench, TicToc, and Google's "Test of Time" all test whether a model can answer temporal questions correctly, not whether it can forecast task duration with calibrated uncertainty ^59^.

This distinction matters because the skills are dissociated. A model that calculates "August 14 to August 21 is 7 days" perfectly may still estimate "this feature will take 3 days" when the historical mean is 9. The software engineering community has established metrics for this exact problem — MMRE (Mean Magnitude of Relative Error) and PRED(25) (percentage of estimates within 25% of actual) — with an accepted quality threshold of MMRE ≤ 0.25 ^6^. Researchers should adapt these metrics into a unified **Duration Estimation Benchmark** that presents LLM agents with real or realistic software tasks, records their time estimates with confidence intervals, and scores against actual completion data. No such benchmark currently exists.

#### 9.3.2 Token-to-Time Mapping Research

LLM agents currently use token budgets (200K–500K per session) as implicit time budgets, but the mapping is broken. Tokens do not linearly correlate with wall-clock minutes because reasoning-time variation, tool-call latency, and parallel execution create unpredictable multipliers ^2^. Agents say "I'll complete this in a few steps" because they reason in token-space, not minute-space.

Research is needed to establish empirical correlations between token budgets and wall-clock duration across different task types, model families, and API tiers. A preliminary model might take the form:

$$T_{wall} = \frac{N_{tokens}}{R_{generation}} + \sum_{i} L_{tool,i} + \alpha \cdot N_{reasoning\_turns}$$

where $R_{generation}$ is the provider's tokens-per-second rate, $L_{tool,i}$ is the measured latency of each tool call, and $\alpha$ is a reasoning overhead coefficient calibrated per model. Such a model would let agents translate their internal token plans into user-meaningful duration estimates for the first time.

#### 9.3.3 Hybrid Intelligence Effort Models

The five LLM-specific cost drivers identified in the Frontiers 2026 framework — reasoning complexity, context completeness, transformation impact, iterative cycles, and human oversight — are currently conceptual parameters without operational measurement protocols ^2^. Researchers should operationalize each driver into a measurable estimation parameter that can be extracted from agent execution traces.

For example, *reasoning complexity* could be quantified as the number of CoT turns or the entropy of tool-call sequences; *iterative cycles* as the count of self-correction loops; *human oversight* as the frequency of human-in-the-loop interrupts per task. Once operationalized, these drivers can be regressed against actual durations to build team-specific hybrid intelligence effort models that outperform both pure-LLM and pure-human estimation. The TReMu framework's approach — combining time-aware memorization with neuro-symbolic code execution — achieved a 160% accuracy improvement over standard prompting ^60^, suggesting that hybrid architectures are the most promising research direction for closing the estimation gap.

### Strategic Recommendations Matrix

Table 1 synthesizes the recommendations by stakeholder across three time horizons. Impact scores reflect the magnitude of estimation accuracy improvement demonstrated in the source research; implementation effort reflects engineering and organizational cost.

| Stakeholder | Time Horizon | Action | Expected Impact | Implementation Effort |
|------------|-------------|--------|-----------------|----------------------|
| **Users / Developers** | Immediate (0–30 days) | ISO 8601 date injection in system prompts | Eliminates ~40% of temporal staleness failures ^58^| Low |
| **Users / Developers** | Immediate | Explicit time-state updates per turn | 8× improvement in time-aware task completion ^3^| Low |
| **Users / Developers** | Immediate | Qualitative urgency cues in prompts | Outperforms numeric countdowns on policy adaptation ^3^| Low |
| **Users / Developers** | Immediate | Delegate all temporal calculations to tools | Near-perfect accuracy on arithmetic; eliminates compositional drift ^7^ ^56^| Medium |
| **Users / Developers** | Medium (1–6 months) | Adopt MCP-based time estimation server | Unifies clock, calendar, estimation, and historical data in one protocol | Medium |
| **Users / Developers** | Medium | Integrate Jira/Asana/Toggl actual-vs-estimated data | Historical reference class reduces error vs. algorithmic models by 15–25% ^2^| Medium |
| **Users / Developers** | Medium | Build team-specific token-to-time baselines | Calibrates the broken implicit time proxy agents currently use | Medium |
| **Tool Builders** | Medium (3–9 months) | Build 5-layer Time Estimation MCP server | First integrated solution in a greenfield category | High |
| **Tool Builders** | Medium | Prioritize PM data integration over algorithmic purity | Each "messiness" point degrades parametric models ~8% ^2^| Medium |
| **Tool Builders** | Medium | Expose categorical + numeric estimate outputs | LLMs process qualitative pressure more reliably than quantities ^3^| Low |
| **Researchers** | Long (6–24 months) | Create unified Duration Estimation Benchmark | No existing benchmark tests predictive duration estimation | High |
| **Researchers** | Long | Establish token-to-time empirical mappings | Bridges the broken token-space / time-space proxy currently used by agents | High |
| **Researchers** | Long | Operationalize 5 LLM-specific cost drivers into measurable parameters | Enables regression-based hybrid intelligence effort models | High |
| **Researchers** | Long | Extend TicToc DPO post-training to proprietary models | DPO shows massive alignment gains on temporal data ^1^| Medium |

The matrix reveals a consistent pattern: the highest-impact, lowest-effort actions all involve making time information externally legible to LLMs rather than attempting to improve internal temporal reasoning. Date injection, urgency cues, and tool delegation are prompt-level changes that require no model retraining or custom infrastructure, yet they address the root architectural limitation — that transformers cannot track continuous time internally. Medium-term investments in MCP servers and historical data integration build systematic capability without waiting for model architecture advances. Long-term research should focus on measurement infrastructure (benchmarks, operationalized parameters) so that future model generations can be evaluated specifically on the predictive estimation task that current benchmarks ignore.

The final strategic implication is that fixing LLM time estimation is not primarily a machine learning research problem. It is an interface design problem, a tooling problem, and a data integration problem. The models will not spontaneously develop continuous-time reasoning; the evidence across UPenn, METR, TicToc, and TimeBench consistently shows that this capability is structurally incompatible with current transformer architectures ^2^ ^1^ ^59^. What models *can* do is leverage external time state, categorical urgency signals, deterministic tool execution, and historical reference data — if the surrounding infrastructure makes these resources available in formats they can process. The stakeholders who build that infrastructure will determine whether LLM time estimates remain a source of friction or become a reliable planning input.


---


# References

## Primary Research Sources

This document synthesizes findings from 12 deep-research dimensions, cross-verification analysis, and insight extraction. The primary research artifacts are:

- **Dimension 01**: Terminology & Taxonomy of LLM Time/Temporal Failures — `/mnt/agents/output/research/llm_time_dim01.md`
- **Dimension 02**: Architectural & Fundamental Causes — `/mnt/agents/output/research/llm_time_dim02.md`
- **Dimension 03**: Training Data & Representational Causes — `/mnt/agents/output/research/llm_time_dim03.md`
- **Dimension 04**: Cognitive Science & Human Time Estimation Parallels — `/mnt/agents/output/research/llm_time_dim04.md`
- **Dimension 05**: Academic Research & Benchmarks on LLM Temporal Reasoning — `/mnt/agents/output/research/llm_time_dim05.md`
- **Dimension 06**: Software Engineering Time Estimation & LLM Agents — `/mnt/agents/output/research/llm_time_dim06.md`
- **Dimension 07**: Current Fixes, Tool Use & Mitigations — `/mnt/agents/output/research/llm_time_dim07.md`
- **Dimension 08**: MCP Server Architecture, Patterns & Best Practices — `/mnt/agents/output/research/llm_time_dim08.md`
- **Dimension 09**: Time Estimation Tool Design & Specification — `/mnt/agents/output/research/llm_time_dim09.md`
- **Dimension 10**: Implementation Guide — Building MCP Server — `/mnt/agents/output/research/llm_time_dim10.md`
- **Dimension 11**: Integration with Coding Agents & Agent Frameworks — `/mnt/agents/output/research/llm_time_dim11.md`
- **Dimension 12**: Evaluation, Testing & Future Work — `/mnt/agents/output/research/llm_time_dim12.md`

## Cross-Verification & Insights

- **Cross-Verification**: `/mnt/agents/output/research/llm_time_cross_verification.md`
- **Insight Extraction**: `/mnt/agents/output/research/llm_time_insight.md`

## Key Academic Sources Cited

- Guntuku, S.C., Ungar, L. et al. (2026). *Real-Time Deadlines Reveal Temporal Awareness Failures in LLM Strategic Dialogues*. arXiv:2601.13206.
- Song, Y. et al. (2026). *Large Language Model Reasoning Failures*. arXiv:2602.06176.
- Yang, X. et al. (2024). *Large Language Models Can Learn Temporal Reasoning*. ACL 2024.
- Schick, T. et al. (2023). *Toolformer: Language Models Can Teach Themselves to Use Tools*. NeurIPS 2023.
- Hahn, M. (2020). *Theoretical Limitations of Self-Attention*. TACL.
- Gong, D. & Zhang, H. (2024). *Self-Attention Limits Working Memory Capacity of Transformer-Based Models*. arXiv:2409.10715.
- METR (2026). *Task-Completion Time Horizons of Frontier AI Models*. metr.org.
- Frontiers in AI (2026). *Toward LLM-aware Software Effort Estimation: A Conceptual Framework*.
- Boehm, B. et al. (1995). *COCOMO II Model Definition Manual*.
- Kahneman, D. & Tversky, A. (1979). *Intuitive Prediction: Biases and Corrective Procedures*.

## Technical Documentation References

- Model Context Protocol Specification: https://modelcontextprotocol.io/
- MCP Python SDK (FastMCP): https://github.com/modelcontextprotocol/python-sdk
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Anthropic MCP Course: https://anthropic.skilljar.com/introduction-to-model-context-protocol
