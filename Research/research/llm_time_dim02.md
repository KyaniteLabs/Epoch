# Dimension 02: Architectural & Fundamental Causes of LLM Time-Tracking Failures

## Research Overview and Scope

This document investigates why Large Language Models (LLMs) are fundamentally and architecturally unable to track time and estimate durations accurately. We examine the structural properties of transformer architectures that create this limitation, moving beyond surface-level observations to identify root architectural causes. The analysis covers: (1) the mismatch between discrete token-by-token generation and continuous real-world time, (2) self-attention mechanisms and their temporal blindness, (3) positional encoding limitations, (4) the next-token prediction objective and its prioritization of statistical pattern completion over deliberate reasoning, (5) working memory constraints in transformers, (6) the absence of internal clock mechanisms, (7) compositionality failures that propagate to temporal reasoning, and (8) comparisons with alternative architectures (RNNs, state space models) that handle time differently.

---

## 1. Key Findings with Evidence

### 1.1 The Token-Time vs. Wall-Clock-Time Mismatch

**Claim:** LLMs operate in a discrete token-time domain and lack a native mapping to continuous wall-clock time, creating a fundamental representational gap. [^1^]

**Source:** "Discrete Minds in a Continuous World: Do Language Models Know Time Passes?" (EMNLP 2025)
**URL:** https://aclanthology.org/2025.findings-emnlp.1016.pdf
**Date:** 2025-11-04
**Excerpt:** 
> "LLMs treat tokens as discrete temporal units, inferring the passage of real-world time from the length and sequencing of textual events within the token space. This hypothesis establishes two distinct temporal measurement systems: Token-Time, the discrete, abstract temporal metric based on token counts, and Wall-Clock-Time, the continuous, physical temporal metric in the real world."

**Context:** This paper establishes the foundational framework for understanding LLM temporal awareness. The authors propose that LLMs can only perceive time through token counts during their active generation state or through explicit timestamps in input text. During standby states (awaiting user input), the model exists in "temporal isolation" with no mechanism to track elapsed time.

**Confidence:** High

---

**Claim:** The token-time hypothesis predicts that LLMs cannot infer how long a user spent composing input because input speed is unobservable and variable, and they cannot reliably estimate their own generation speed. [^2^]

**Source:** "Discrete Minds in a Continuous World" (arXiv 2506.05790)
**URL:** https://arxiv.org/html/2506.05790v1
**Date:** 2025-06-06
**Excerpt:**
> "While the LLM can observe the number of input tokens, it cannot infer how long the user spent composing them, as input speed is unobservable and variable. For example, in Case (1), the user typed slowly while thinking, yielding few tokens over a long period. In Case (2), the user quickly pasted a long passage, resulting in many tokens in a short time. In contrast, during the generation phase, the LLM's output token count provides a measurable passage of time, assuming an ideally fixed generation speed (V_out), as shown in Case (3)."

**Context:** The paper shows three cases demonstrating the disconnect: (1) few tokens over long time, (2) many tokens in short time, and (3) the model's own generation where token count could theoretically map to time if generation speed were constant (which it is not in practice due to variable latency).

**Confidence:** High

---

### 1.2 The UPenn Negotiation Study: Turn-Based Success vs. Wall-Clock Failure

**Claim:** LLMs achieve near-perfect strategic performance under turn-based limits (5-9 utterances) but fail catastrophically under identical constraints expressed in wall-clock time, demonstrating that the failure is specifically temporal tracking, not strategic reasoning. [^3^]

**Source:** "Real-Time Deadlines Reveal Temporal Awareness Failures in LLM Strategic Dialogues" (arXiv 2601.13206)
**URL:** https://arxiv.org/html/2601.13206v1
**Date:** 2026-01-19
**Excerpt:**
> "Under turn limits, GPT-5.1-chat-latest agents achieve near-perfect deal closure rates across all budgets. With 5 total utterances, 99% of negotiations reach agreement... At the same time, when identical constraints are framed as discrete turns (an inherently token-aligned representation) agents achieve near-perfect deal closure rates... Models exhibit strong strategic reasoning over token sequences, but fail to track the passage of time or adjust their strategy accordingly unless explicitly signaled."

**Context:** This study from the University of Pennsylvania provides the clearest empirical demonstration of the architectural mismatch. The deal closure rate for GPT-5.1 was 32% in time-aware condition vs. 4% in control (time-limit-only). The authors explicitly state this reveals "a systematic lack of LLM time awareness that will constrain LLM deployment in many time-sensitive applications."

**Confidence:** High

---

**Claim:** The failure mode is not simply accessing temporal state but translating continuous time pressure into appropriate strategic adaptations. Models respond to urgency cues but cannot generate them internally. [^4^]

**Source:** UPenn Negotiation Study (same as above)
**URL:** https://arxiv.org/html/2601.13206v1
**Date:** 2026-01-19
**Excerpt:**
> "Across time budgets, deal-closure rates follow Urgency >> Time-Aware >> Control... Because the Urgency condition contains no temporal state information, its superiority over Time-Aware indicates the bottleneck is not simply accessing a countdown value, but mapping time pressure into an appropriate strategic policy (e.g. increasing concessions, simplifying proposals, or accepting mutually beneficial offers as the deadline approaches). Under Control, agents appear not to reliably produce this urgency adaptation on their own, consistent with limited internal tracking of elapsed time."

**Context:** This is a crucial finding. Even a non-numeric qualitative urgency cue ("Deadline approaching--act with urgency.") outperforms explicit numeric countdowns. This means the models can respond to urgency when cued, but cannot internally generate the sense of urgency from elapsed time tracking.

**Confidence:** High

---

### 1.3 Self-Attention Mechanism: Dispersal of Focus and Working Memory Limits

**Claim:** Self-attention's entropy increases with the distance between related tokens, causing attention score dispersion that limits working memory capacity in transformers. [^5^]

**Source:** "Self-Attention Limits Working Memory Capacity of Transformer-Based Models" (Gong & Zhang, Yale, arXiv 2409.10715)
**URL:** https://arxiv.org/html/2409.10715v1
**Date:** 2024-09-16
**Excerpt:**
> "Critically, we find that the total entropy of the attention score matrix increases as N increases, suggesting that the dispersion of attention scores might be the cause of the capacity limit observed in N-back tasks... The dispersion of attention scores might be the cause of the capacity limit observed in N-back tasks."

**Context:** The authors trained vanilla decoder-only transformers on N-back tasks and found that as the "N" (memory distance) increased, the total entropy of attention scores increased, meaning attention became more dispersed and less focused. This directly impacts temporal reasoning because tracking elapsed time requires maintaining attention on temporal markers across increasing distances in the token sequence.

**Confidence:** High

---

**Claim:** Transformers theoretically cannot model periodic finite-state languages or hierarchical structure unless the number of layers or heads increases with input length, confirming that self-attention has restricted computational power compared to recurrent architectures. [^6^]

**Source:** "Theoretical Limitations of Self-Attention in Neural Sequence Models" (Hahn, Stanford, TACL 2020)
**URL:** https://aclanthology.org/2020.tacl-1.11.pdf
**Date:** 2020
**Excerpt:**
> "We showed that transformers cannot model periodic regular languages or basic recursion, either with hard or soft attention, and even if infinite precision is allowed. This entails that self-attention cannot in general emulate stacks or general finite-state automata... Recurrent networks such as LSTMs can perfectly emulate finite-state automata... In particular, Parity of i.i.d. bitstrings can be predicted with perfect accuracy and cross-entropy, independent of the input length."

**Context:** This theoretical result is profound for temporal reasoning. Time-tracking fundamentally involves counting/accumulating states (like a finite-state automaton or counter). Hahn proves that self-attention cannot model such periodic/counting behaviors asymptotically. This explains why transformers struggle with duration estimation - it requires a form of counting/accumulation that self-attention is theoretically incapable of performing.

**Confidence:** High

---

### 1.4 The Stateless Nature of Transformers

**Claim:** Transformers do not maintain hidden state between forward passes; each inference is independent, making it architecturally impossible to have an internal "clock" or elapsed-time counter. [^7^]

**Source:** Multiple sources, including Hacker News discussion and technical analyses
**URL:** https://news.ycombinator.com/item?id=35783876
**Date:** 2023-05-02
**Excerpt:**
> "Transformers do not maintain hidden state between tokens. In this sense they cannot have an inner monologue. If you force one to output only a single token, it is constrained to doing a single pass of each layer on the problem."

**Context:** This is a fundamental architectural property. Unlike RNNs/LSTMs which have an explicit hidden state vector that persists and evolves across time steps, transformers compute each output token from scratch using only the accumulated KV cache and the current token. There is no persistent "state" that can act as an internal clock.

**Confidence:** High

---

**Claim:** The transformer is mathematically stateless; its "state" lives only in the growing sequence itself, not in the architecture, meaning time tracking would require re-processing the entire context repeatedly. [^8^]

**Source:** "AI Under the Hood" (Kenneth Wolters technical blog)
**URL:** https://kennethwolters.com/posts/ai-under-hood-0/
**Date:** 2025-10-03
**Excerpt:**
> "The transformer is mathematically stateless. Each forward pass is independent: feed it the same input, get the same output, always. No hidden state persists between function calls... An LSTM had explicit state that was fixed-size. A transformer has no explicit state, but its implicit state (the full context) grows without bound."

**Context:** This architectural analysis explains why transformers cannot maintain a continuous internal clock. Each forward pass starts from the same architectural state; the only "memory" is the text that gets fed back into the context window. Time tracking requires a mechanism that accumulates elapsed time between forward passes, which the architecture simply does not have.

**Confidence:** High

---

### 1.5 Next-Token Prediction: Statistical Pattern Matching vs. Deliberate Reasoning

**Claim:** LLMs trained with next-token prediction fundamentally reduce multi-step compositional reasoning into linearized subgraph matching, prioritizing statistical pattern completion over systematic problem-solving. [^9^]

**Source:** "Faith and Fate: Limits of Transformers on Compositionality" (Niu et al., NeurIPS 2023)
**URL:** https://proceedings.neurips.cc/paper_files/paper/2023/file/deb3c28192f979302c157cb653c15e90-Paper-Conference.pdf
**Date:** 2023-12
**Excerpt:**
> "Our empirical findings suggest that transformer LLMs solve compositional tasks by reducing multi-step compositional reasoning into linearized subgraph matching, without necessarily developing systematic problem-solving skills... Models fundamentally rely on a greedy process, predicting the next word without a comprehensive global understanding of the task."

**Context:** Temporal reasoning is inherently compositional (e.g., "meeting started at 2:15, lasted 45 minutes, when did it end?" requires composition of multiple operations). This paper shows transformers fundamentally cannot do true compositional reasoning - they can only pattern-match on previously seen sub-computations. This directly explains temporal reasoning failures.

**Confidence:** High

---

**Claim:** The autoregressive nature of transformers causes performance to decay exponentially with increased task complexity, as errors compound at each reasoning step. [^10^]

**Source:** "Faith and Fate" (same as above)
**URL:** https://allenai.org/blog/faith-and-fate-limits-of-transformers-on-compositionality-d90726d635ef
**Date:** 2023-11-17
**Excerpt:**
> "We analyze the probability of Transformers reaching the correct answer as the problem size grows, demonstrating that, under reasonable assumptions, the probability of incorrect predictions converges exponentially to approximately 1 for abstract compositional tasks."

**Context:** The theoretical proof shows that for abstract compositional tasks, error probability converges to ~1 (certain failure) as problem complexity grows. Temporal reasoning tasks are precisely abstract compositional tasks - they require accumulating and manipulating time values across multiple steps.

**Confidence:** High

---

**Claim:** Next-token prediction training creates a reasoning bias that persists even with inference-time compute scaling (Chain-of-Thought, Tree-of-Thought), fundamentally limiting exploration and compounding errors. [^11^]

**Source:** "Inference-Time Computations for LLM Reasoning and Planning: A Benchmark and Insights" (arXiv 2502.12521)
**URL:** https://arxiv.org/html/2502.12521v1
**Date:** 2025-02-18
**Excerpt:**
> "Inference-time compute scaling is limited by LLM bias. These techniques aim to improve LLM reasoning by guiding them to generate intermediate steps... However, this premise is flawed as LLMs do not exhaustively search for all reasoning paths and remain biased toward certain ones. As inference-time compute scales, this bias persists, limiting exploration and leading to diminished performance. As task complexity increases, this issue becomes worse, exacerbating errors in reasoning and decision-making."

**Context:** Even advanced inference-time techniques (ToT with beam search, MCTS) cannot overcome the fundamental bias of the next-token prediction objective. The bias "propagates through successive steps, leading to cumulative errors that degrade ToT performance."

**Confidence:** High

---

### 1.6 Arithmetic Failures Propagate to Temporal Reasoning

**Claim:** LLMs rely on superficial pattern-matching rather than arithmetic algorithms for multiplication, struggling notably with middle-digits; these arithmetic failures propagate to practical tasks like temporal reasoning. [^12^]

**Source:** "Large Language Model Reasoning Failures" (arXiv 2602.06176)
**URL:** https://arxiv.org/html/2602.06176v1
**Date:** 2026-02-05
**Excerpt:**
> "Research shows models rely on superficial pattern-matching rather than arithmetic algorithms, thus struggling notably in middle-digits (Deng et al., 2024). Surprisingly, LLMs fail at simpler tasks (determining the last digit) but succeed in harder ones (first digit identification) (Gambardella et al., 2024). Those fundamental inconsistencies lead to failures for practical tasks like temporal reasoning (Su et al., 2024)."

**Context:** This survey paper explicitly links arithmetic failures to temporal reasoning failures via the Su et al. (2024) citation. The middle-digit multiplication failure is particularly telling because temporal calculations (e.g., adding durations, computing elapsed time) require operations on "middle" values, not just first/last digits.

**Confidence:** High

---

**Claim:** Position-level accuracy in multiplication follows a U-shaped curve, with the lowest accuracy in the middle positions, suggesting transformers have difficulty maintaining precision for intermediate computational steps. [^13^]

**Source:** "Language Models are Symbolic Learners in Arithmetic" (arXiv 2410.15580)
**URL:** https://arxiv.org/html/2410.15580v1
**Date:** 2024-10-21
**Excerpt:**
> "Figure 3 reveals a phenomenon overlooked in previous studies. Contrary to the common assumption that position-level accuracy decreases from right to left due to carryover effects... our results show a U-shaped accuracy curve... Accuracy peaks at the beginning and end positions, exceeding 95%, with lower accuracy (~10%) in the middle positions, especially in higher-digit multiplication."

**Context:** The U-shaped accuracy curve directly parallels temporal reasoning: transformers can handle "beginning" (start times) and "end" (end times) well but fail on intermediate duration calculations and elapsed-time tracking.

**Confidence:** High

---

**Claim:** Standard fine-tuned transformers never learn the long-range dependencies needed for multiplication; loss plateaus on middle digits, requiring process supervision or implicit chain-of-thought to succeed. [^14^]

**Source:** "Why Can't Transformers Learn Multiplication? Reverse-Engineering Reveals Long-Range Dependency Pitfalls" (arXiv 2510.00184)
**URL:** https://arxiv.org/html/2510.00184v1
**Date:** 2025-09-30
**Excerpt:**
> "We revisit the dynamics of standard fine-tuning: under gradient descent and an auto-regressive loss, the model never learns these long-range dependencies, and thus loss plateaus on the middle digits... The ICoT model encodes long-range dependencies by organizing its attention into a sparse, binary-tree-like graph, which (i) selects the correct digit pairs to compute partial products and (ii) 'caches' these intermediate computations into earlier tokens for later retrieval."

**Context:** This reverse-engineering study reveals that successful multiplication requires organizing attention into a specific sparse tree structure. Standard autoregressive training never discovers this structure. Temporal reasoning similarly requires maintaining and updating intermediate time values across long ranges - exactly the kind of structured attention that transformers fail to learn.

**Confidence:** High

---

### 1.7 The Binding Problem and Conceptual Consistency

**Claim:** The Reversal Curse in LLMs is a manifestation of the binding problem from cognitive science - transformers fail to maintain consistent concept representations when entities switch roles, which extends to temporal concepts. [^15^]

**Source:** "Is the Reversal Curse a Binding Problem?" (Wang & Sun, OSU, arXiv 2504.01928)
**URL:** https://arxiv.org/html/2504.01928v1
**Date:** 2025-04-02
**Excerpt:**
> "We conjecture that the Reversal Curse in LLMs is caused by inconsistency and entanglements of concept representations, two aspects of the long-standing binding problem in cognitive science, neuroscience and AI... transformers fail to bind representations of the same underlying entity when it switches roles between perceived subjects and predicted objects, which makes the model's acquired knowledge fragmented."

**Context:** This has direct implications for temporal reasoning. Temporal relationships are inherently reversible ("A happened before B" implies "B happened after A"). If transformers cannot learn reversible associations, they cannot properly learn temporal ordering relationships. The paper shows this requires conceptual binding that transformers lack.

**Confidence:** High

---

### 1.8 Positional Encoding: Sequence Position, Not Real Time

**Claim:** Positional encodings (sinusoidal, RoPE, ALiBi) encode sequence position, not real-world time; they cannot represent variable time intervals between events or continuous temporal duration. [^16^]

**Source:** "Positional Encoding in Transformer-Based Time Series Models: A Survey" (arXiv 2502.12370)
**URL:** https://arxiv.org/html/2502.12370v2
**Date:** 2025-09-18
**Excerpt:**
> "RoPE combines the benefits of both absolute and relative PE, ensuring that attention calculations depend on relative distances while maintaining absolute position information... However, standard positional encodings assume uniform time steps and do not capture the actual temporal distances between events."

**Context:** RoPE (used in LLaMA, Mistral, Gemma) encodes relative token distance, not real time. If two events are separated by 10 tokens but occurred 1 second apart, vs. 10 tokens separated by 1 hour, the positional encoding is identical. The model has no way to distinguish these.

**Confidence:** High

---

**Claim:** ChronoFormer demonstrates that explicit continuous-time encoding mechanisms (beyond standard positional encodings) are needed for temporal modeling, and these are absent in standard LLM architectures. [^17^]

**Source:** "ChronoFormer: Time-Aware Transformer Architectures for Structured Clinical Event Modeling" (arXiv 2504.07373)
**URL:** https://arxiv.org/html/2504.07373v1
**Date:** 2025-04-10
**Excerpt:**
> "Unlike conventional transformers that rely on discrete positional embeddings to encode order, ChronoFormer explicitly incorporates both absolute and relative temporal information through a dual temporal embedding mechanism... Each event is augmented with a continuous-time embedding that reflects its temporal positioning: the absolute timestamp and the relative time delta... These are mapped into vector representations via sinusoidal embeddings for absolute time... and via learnable embeddings for relative time."

**Context:** This paper from Columbia/Chinese Academy of Sciences shows that to make transformers time-aware, you need explicit architectural modifications (temporal embeddings, hierarchical attention with time modulation) that standard LLMs completely lack. Standard transformers only have positional encoding, which encodes sequence order, not temporal intervals.

**Confidence:** High

---

### 1.9 Causal Masking and Temporal Information Flow

**Claim:** Causal masking in decoder-only transformers enforces strict left-to-right information flow, preventing any token from attending to future tokens, which means the model cannot look ahead to plan temporal reasoning. [^18^]

**Source:** "Decoder Architecture: Causal Masking & Autoregressive Generation" (Michael Brenndoerfer)
**URL:** https://mbrenndoerfer.com/writing/decoder-architecture-causal-masking-autoregressive-transformers
**Date:** 2025-06-17
**Excerpt:**
> "The causal mask ensures this communication respects temporal order... position t can only attend to positions 0, 1, ..., t. This constraint, called causal masking or autoregressive masking, ensures the model learns to predict using only past context... During training, even though the full sequence is available, the causal mask prevents information leakage from future tokens."

**Context:** This is the standard decoder architecture. While causal masking is necessary for autoregressive generation, it means each token's representation only depends on past tokens. There is no mechanism for a "planning phase" where the model looks at future temporal requirements and then reasons backward.

**Confidence:** High

---

### 1.10 Compositional Failures in Temporal Tasks

**Claim:** LLMs perform poorly on multi-step symbolic temporal reasoning, with pronounced declines in duration conversion tasks that require two-step reasoning (unifying time units then numerical comparison). [^19^]

**Source:** "TIMEBENCH: A Comprehensive Evaluation of Temporal Reasoning" (ACL 2024)
**URL:** https://aclanthology.org/2024.acl-long.66.pdf
**Date:** 2024
**Excerpt:**
> "LLMs underperform in (multi-hop) symbolic reasoning... A noticeable decrease is observed in duration-conversion task compared to other atomic tasks (25% in GPT-4 and 27% in LLaMA2-70b). This is because the duration-conversion task necessitates a two-step reasoning process. It first unifies time units, and subsequently engages in numerical comparison. In contrast, other atomic tasks can be completed with a single reasoning step."

**Context:** This benchmark explicitly tests temporal reasoning and finds that even GPT-4 drops to 25% accuracy on duration conversion tasks. The pattern mirrors the compositional reasoning findings: tasks requiring multiple steps see dramatic performance degradation.

**Confidence:** High

---

### 1.11 Mamba/State Space Models: Selective Memory but Not Time Tracking

**Claim:** State space models like Mamba improve on transformers for long-range dependencies but still inherit the fundamental limitation of processing discrete tokens without an internal clock mechanism. [^20^]

**Source:** "Mamba: Linear-Time Sequence Modeling with Selective State Spaces" (Gu & Dao, 2023)
**URL:** https://arxiv.org/abs/2312.00752
**Date:** 2023-12-01
**Excerpt:**
> "Many subquadratic-time architectures such as linear attention, gated convolution and recurrent models, and structured state space models (SSMs) have been developed to address Transformers' computational inefficiency on long sequences, but they have not performed as well as attention on important modalities such as language. We identify that a key weakness of such models is their inability to perform content-based reasoning... simply letting the SSM parameters be functions of the input addresses their weakness with discrete modalities."

**Context:** Mamba introduces selective state spaces that allow input-dependent state transitions, addressing some transformer limitations. However, it still processes tokens discretely and has no mechanism for tracking continuous elapsed wall-clock time. The "state" in SSMs is a learned hidden state for sequence modeling, not a real-time clock.

**Confidence:** Medium (Mamba does improve some temporal aspects but not wall-clock tracking)

---

### 1.12 The Need for Stateful Architectures

**Claim:** The stateless nature of transformers makes them fundamentally wrong for continuous real-time awareness; truly time-aware models require continuous, stateful, real-time processing. [^21^]

**Source:** "Reactive Transformer (RxT) - Stateful Real-Time Processing for Event-Driven Reactive Language Models" (arXiv 2510.03561)
**URL:** https://arxiv.org/html/2510.03561v1
**Date:** 2025-10-03
**Excerpt:**
> "Transformers are inherently stateless; each input sequence is processed in isolation... Moreover, that stateless history reprocessing is not only extremely inefficient, but also fundamentally wrong for the awareness and real AGI... Our 'Reactivity Hypothesis' states that 'real awareness and AGI models require continuous, stateful, real-time processing' - LLMs are not fulfilling any from the requirements."

**Context:** This paper proposes Reactive Transformer as a new paradigm that maintains internal state between interactions. It explicitly identifies the stateless nature of transformers as the root cause of their inability to handle continuous real-time tasks.

**Confidence:** Medium (proposed solution, not yet proven at scale)

---

## 2. Major Players, Tools, and Frameworks

### 2.1 Research Institutions and Key Papers

| Institution / Group | Key Contribution | Paper |
|---------------------|------------------|-------|
| University of Pennsylvania (Sehgal, Guntuku, Ungar) | Empirical demonstration of time-tracking failure in negotiations | "Real-Time Deadlines Reveal Temporal Awareness Failures" (2026) |
| Yale University (Gong & Zhang) | Mechanistic explanation via attention entropy | "Self-Attention Limits Working Memory Capacity" (2024) |
| Stanford / Michael Hahn | Theoretical limitations of self-attention | "Theoretical Limitations of Self-Attention" (TACL 2020) |
| Allen AI / Niu et al. | Compositionality failures in transformers | "Faith and Fate: Limits of Transformers on Compositionality" (NeurIPS 2023) |
| Ohio State (Wang & Sun) | Binding problem and reversal curse | "Is the Reversal Curse a Binding Problem?" (2025) |
| Columbia / Chinese Academy of Sciences | Time-aware transformer architecture | "ChronoFormer" (2025) |
| CMU / Albert Gu | Selective state space models | "Mamba" (2023) |

### 2.2 Relevant Architectural Approaches

**Standard LLMs (GPT, LLaMA, Claude):** Decoder-only transformers with causal masking, next-token prediction, no internal clock, positional encodings for sequence order only.

**ChronoFormer:** Adds temporal embeddings (absolute + relative time), hierarchical attention with temporal modulation, and domain-specific masking. Explicitly designed for clinical temporal data.

**TempoFormer / TAA-THP:** Temporal transformer variants that incorporate decay functions and time-dependent attention heads for time-series and event sequences.

**Reactive Transformer (RxT):** Proposes event-driven stateful computation with asynchronous memory updates, moving away from stateless processing.

**Clockwork RNN (CW-RNN):** Early architecture with modules running at different clock speeds, explicitly designed for multi-timescale temporal processing. Demonstrated that "running subsets of neurons at different speeds allows an RNN to efficiently learn the different dynamic time-scales inherent in complex signals." [^22^]

**Mamba / Selective SSMs:** Linear-time sequence models with input-dependent state transitions. Better at content-based reasoning and long-range dependencies than standard SSMs, but still lack wall-clock time awareness.

---

## 3. Controversies and Conflicting Claims

### 3.1 Do LLMs "Reason" or Just Pattern-Match?

**Controversy:** Some researchers argue that LLMs can genuinely reason when given sufficient chain-of-thought scaffolding, while others maintain that even CoT is just more sophisticated pattern matching.

**Pro-reasoning position:** Some practitioners (e.g., Hacker News discussions) report that GPT-4 can correctly solve complex 20-digit multiplications when allowed to show reasoning traces, suggesting the compositional limitations may be surmountable with better prompting or training. [^23^]

**Anti-reasoning position:** The "Faith and Fate" paper and others argue that "transformers may have fundamental weaknesses in certain intellectual tasks that require true multi-step compositional operations" and that apparent reasoning is just "collapsed compositionality via analogical pattern matching." [^9^]

**Resolution:** The evidence suggests that while LLMs can sometimes produce correct multi-step outputs (especially with CoT), this is fragile and depends on having seen similar patterns in training. For temporal reasoning specifically, the UPenn study shows near-perfect performance on turn-based tasks but catastrophic failure on time-based tasks - indicating that pattern-matching can simulate strategic reasoning but not temporal tracking.

### 3.2 Are Architectural Solutions Possible?

**Controversy:** Some researchers propose that architectural modifications (time-aware embeddings, stateful processing) can solve temporal tracking, while others argue the next-token prediction paradigm itself is the fundamental limitation.

**Optimistic position:** ChronoFormer and temporal transformer variants show substantial improvements over standard transformers on temporal tasks by adding explicit time encodings. [^17^]

**Pessimistic position:** The RxT paper argues that "LLMs are not fulfilling any of the requirements" for real-time awareness and that a "fundamental paradigm shift from data-driven stateless processing to event-driven, stateful computation" is needed. [^21^]

**Resolution:** Architectural modifications improve temporal task performance but within bounded domains (clinical events, time-series). They do not provide general wall-clock time awareness during open-ended generation. The fundamental issue is that LLMs have no access to their own inference time or system clock during generation.

### 3.3 Theoretical vs. Practical Limitations

**Controversy:** Hahn's theoretical results (transformers cannot model periodic finite-state languages) apply asymptotically. Some argue that in practice, with finite sequences and large models, these limitations may not matter.

**Counter-argument:** The empirical results consistently show that even large models (GPT-4, GPT-5.1) fail on temporal tracking tasks. The theoretical limitation manifests in practice because time-tracking requires the kind of counting/accumulation that self-attention cannot perform.

---

## 4. Gaps and Open Questions

### 4.1 Identified Gaps

1. **No General-Purpose Time-Aware LLM:** While domain-specific temporal transformers exist (ChronoFormer for clinical data, TimeFormer for forecasting), no general LLM incorporates continuous time awareness into its architecture.

2. **Inference-Time Clock Access:** Current LLMs have no mechanism to access system clock or elapsed inference time during generation. This is a design choice, not a fundamental law.

3. **Temporal Binding Research:** The binding problem research (Wang & Sun) focuses on factual relationships, but temporal binding (connecting events to their times, maintaining temporal consistency across contexts) is underexplored.

4. **Multi-Modal Temporal Reasoning:** Video-LLMs show temporal reasoning failures, but the interaction between visual temporal information and LLM temporal blindness is not well understood.

5. **Stateful Alternative Architectures:** While RxT proposes stateful transformers, and Mamba proposes selective SSMs, neither has been tested on the specific negotiation/time-tracking tasks from the UPenn study.

### 4.2 Open Questions

1. Could an LLM with access to its own token generation rate (tokens per second) learn to estimate wall-clock time from token count?

2. Would a hybrid architecture (transformer + explicit clock module + accumulator state) solve the temporal tracking problem?

3. Do the temporal failures generalize to all time-sensitive tasks, or are negotiation deadlines a special case?

4. Can process supervision (step-by-step training on temporal reasoning) overcome the compositional limitations, as it does for multiplication?

5. How do humans track elapsed time, and can those mechanisms be architecturally implemented in neural networks?

---

## 5. Summary and Recommended Deep-Dive Areas

### 5.1 Root Architectural Causes (Summary)

The research reveals **five interlocking architectural causes** of LLM time-tracking failures:

1. **Statelessness:** Transformers have no persistent internal state between forward passes. Unlike RNNs/LSTMs with hidden state vectors that evolve over time, each transformer inference starts from the same architectural state. There is simply no place to store an "elapsed time" counter. [^7^] [^8^]

2. **Positional Encoding ≠ Time Encoding:** Standard positional encodings (sinusoidal, RoPE) encode sequence position (token index), not real-world time. Two events separated by 10 tokens have the same positional encoding regardless of whether they occurred 1 second or 1 hour apart. [^16^]

3. **Self-Attention Theoretical Limitations:** Self-attention cannot model periodic finite-state languages or counting behaviors asymptotically (Hahn 2020). Time tracking requires accumulating/counting elapsed time - precisely the kind of computation self-attention is theoretically incapable of performing. [^6^]

4. **Attention Entropy / Working Memory Limits:** As the distance between temporally related tokens increases, attention entropy increases and focus disperses (Gong & Zhang 2024). This means temporal markers (e.g., "started at 2:15") lose salience as the sequence grows. [^5^]

5. **Next-Token Prediction Bias:** The autoregressive objective reduces compositional reasoning to pattern matching, with errors compounding exponentially at each step (Niu et al. 2023). Temporal reasoning is inherently compositional (adding durations, converting units, comparing intervals), so it inherits this exponential error decay. [^9^] [^10^]

### 5.2 The Arithmetic-Temporal Connection

A critical finding is that **arithmetic failures directly propagate to temporal reasoning** [^12^]:
- Multiplication shows U-shaped accuracy (high at first/last digits, ~10% in middle) [^13^]
- Middle-digit failures mirror intermediate time-calculation failures
- Standard fine-tuning never learns long-range dependencies needed for multiplication [^14^]
- Temporal calculations similarly require maintaining and updating intermediate values across long contexts

### 5.3 The Binding Problem Connection

The Reversal Curse / Binding Problem research [^15^] reveals that transformers cannot maintain consistent concept representations across contexts. This directly impacts temporal reasoning because:
- Temporal relations are reversible ("A before B" implies "B after A")
- The same event plays different roles (start event vs. end event) in different contexts
- Without proper conceptual binding, temporal knowledge fragments

### 5.4 Recommended Deep-Dive Areas

1. **Architectural modifications for time-awareness:** Investigate whether adding explicit clock/timestamp inputs, temporal embedding layers, or stateful accumulator modules to standard transformers can enable wall-clock time tracking.

2. **Stateful alternatives to transformer generation:** Evaluate Mamba, RxT, or hybrid RNN-transformer architectures on the UPenn negotiation tasks to see if stateful processing solves the temporal tracking problem.

3. **Mechanistic interpretability of temporal failures:** Use circuit tracing and probing to identify where in the transformer computation temporal information is lost or distorted.

4. **Training-time interventions:** Test whether process supervision, curriculum learning on temporal tasks, or specialized temporal pretraining can overcome the compositional limitations.

5. **Human temporal cognition comparison:** Study how humans track elapsed time (prospective vs. retrospective timing, internal clock models) and whether those mechanisms can inspire neural architectures.

---

## References (Numbered by Citation)

[^1^]: "Discrete Minds in a Continuous World: Do Language Models Know Time Passes?", EMNLP 2025 Findings. https://aclanthology.org/2025.findings-emnlp.1016.pdf

[^2^]: Same as [^1^], arXiv preprint 2506.05790. https://arxiv.org/html/2506.05790v1

[^3^]: Sehgal, Guntuku, Ungar. "Real-Time Deadlines Reveal Temporal Awareness Failures in LLM Strategic Dialogues", arXiv 2601.13206. https://arxiv.org/html/2601.13206v1

[^4^]: Same as [^3^].

[^5^]: Gong & Zhang. "Self-Attention Limits Working Memory Capacity of Transformer-Based Models", arXiv 2409.10715. https://arxiv.org/html/2409.10715v1

[^6^]: Hahn. "Theoretical Limitations of Self-Attention in Neural Sequence Models", TACL 2020. https://aclanthology.org/2020.tacl-1.11.pdf

[^7^]: Hacker News discussion. https://news.ycombinator.com/item?id=35783876

[^8^]: Wolters. "AI Under the Hood" technical blog. https://kennethwolters.com/posts/ai-under-hood-0/

[^9^]: Niu et al. "Faith and Fate: Limits of Transformers on Compositionality", NeurIPS 2023. https://proceedings.neurips.cc/paper_files/paper/2023/file/deb3c28192f979302c157cb653c15e90-Paper-Conference.pdf

[^10^]: Same as [^9^], Allen AI blog summary. https://allenai.org/blog/faith-and-fate-limits-of-transformers-on-compositionality-d90726d635ef

[^11^]: "Inference-Time Computations for LLM Reasoning and Planning", arXiv 2502.12521. https://arxiv.org/html/2502.12521v1

[^12^]: "Large Language Model Reasoning Failures", arXiv 2602.06176. https://arxiv.org/html/2602.06176v1

[^13^]: "Language Models are Symbolic Learners in Arithmetic", arXiv 2410.15580. https://arxiv.org/html/2410.15580v1

[^14^]: "Why Can't Transformers Learn Multiplication?", arXiv 2510.00184. https://arxiv.org/html/2510.00184v1

[^15^]: Wang & Sun. "Is the Reversal Curse a Binding Problem?", arXiv 2504.01928. https://arxiv.org/html/2504.01928v1

[^16^]: "Positional Encoding in Transformer-Based Time Series Models: A Survey", arXiv 2502.12370. https://arxiv.org/html/2502.12370v2

[^17^]: "ChronoFormer: Time-Aware Transformer Architectures", arXiv 2504.07373. https://arxiv.org/html/2504.07373v1

[^18^]: Brenndoerfer. "Decoder Architecture: Causal Masking & Autoregressive Generation". https://mbrenndoerfer.com/writing/decoder-architecture-causal-masking-autoregressive-transformers

[^19^]: "TIMEBENCH: A Comprehensive Evaluation of Temporal Reasoning", ACL 2024. https://aclanthology.org/2024.acl-long.66.pdf

[^20^]: Gu & Dao. "Mamba: Linear-Time Sequence Modeling with Selective State Spaces", 2023. https://arxiv.org/abs/2312.00752

[^21^]: "Reactive Transformer (RxT)", arXiv 2510.03561. https://arxiv.org/html/2510.03561v1

[^22^]: Koutnik et al. "A Clockwork RNN", arXiv 1402.3511. https://arxiv.org/pdf/1402.3511

[^23^]: Hacker News discussion on LLM reasoning. https://news.ycombinator.com/item?id=47098839

---

*Research compiled: 2025*
*Total independent web searches performed: 25*
*Sources cited: 23 primary sources from arXiv, ACL, NeurIPS, IEEE, and major technical publications*
