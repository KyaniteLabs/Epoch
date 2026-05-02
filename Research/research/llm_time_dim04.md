# Dimension 04: Cognitive Science & Human Time Estimation Parallels

## 1. Dimension Overview and Scope

This dimension investigates how human cognitive biases in time estimation compare to large language model (LLM) failures in temporal reasoning, and what cognitive science can teach us about improving AI time estimation. The scope spans:

- **Human cognitive biases**: planning fallacy, optimism bias, anchoring, affective forecasting errors, Parkinson's Law, Hofstadter's Law
- **Neuroscience of time perception**: dopaminergic clock models, striatal beat frequency, prefrontal cortex timing circuits, attentional gate models
- **Software engineering estimation**: expert judgment failures, reference class forecasting, PERT, evidence-based scheduling
- **LLM temporal reasoning failures**: benchmark results, anchoring in numerical estimation, event-conditioned reasoning gaps
- **Cross-domain insights**: what embodied, goal-driven human time cognition offers that LLMs lack

The central research question: *If humans are systematically bad at time estimation due to well-documented cognitive biases, and LLMs are also bad at time estimation but for different reasons, what can we learn by comparing these failure modes?*

---

## 2. Key Findings with Evidence Blocks

### 2.1 The Planning Fallacy and Hofstadter's Law: Universal Human Time Underestimation

The planning fallacy, first documented by Kahneman and Tversky (1979), describes the systematic human tendency to underestimate task completion times despite knowledge that similar tasks have typically run late [^146^].

```
Claim: The planning fallacy is a "hardwired tendency to imagine the best-case path to completion and treat it as a prediction," and teams amplify this through social pressure, dependency blindness, and lack of shared historical throughput data [^119^]
Source: Modus Institute / Kahneman & Tversky research synthesis
URL: https://modusinstitute.com/blog/kahneman-team-planning-fallacy
Date: 2026-02-27
Excerpt: "Teams consistently miss their planning estimates not because they're bad at math, but because of a cognitive pattern Daniel Kahneman called the planning fallacy — the hardwired tendency to imagine the best-case path to completion and treat it as a prediction. In groups, this gets worse: social pressure in planning sessions turns estimates into performances of competence rather than honest forecasts."
Context: Applied to agile software team planning
Confidence: high
```

Hofstadter's Law, coined by cognitive scientist Douglas Hofstadter in 1979, states recursively: "It always takes longer than you expect, even when you take into account Hofstadter's Law" [^49^].

```
Claim: Hofstadter's Law is recursive and captures the infinite regress of uncertainty — even after accounting for the law, one must still account for it again [^52^]
Source: Pareto Analysis Tools
URL: https://www.paretoanalysis.tools/hofstadters-law-and-the-planning-fallacy/
Date: 2021-01-09
Excerpt: "Hofstadter's Law is recursive by nature as it calls itself in a never-ending way... The recursive nature of Hofstadter's Law is the way Douglas Hofstadter suggests to account for the things you don't know, even if you don't know them. It is therefore technically impossible to ever fully take Hofstadter's Law into account."
Context: Project management and software development
Confidence: high
```

The planning fallacy operates through what Kahneman termed the "inside view" — building estimates from imagined scenarios — versus the "outside view" — using base rates from similar past projects [^119^][^167^].

```
Claim: Kahneman and Tversky (1979) theorized that the planning fallacy arises because people focus on a single plausible scenario for completing a task and ignore uncertainty, neglecting distributional data from similar past outcomes [^151^]
Source: NBER Working Paper 14228 (Brunnermeier, Parker, Papakonstantinou)
URL: https://www.nber.org/system/files/working_papers/w14228/w14228.pdf
Date: Unknown (cited 2008)
Excerpt: "The planning fallacy is a consequence of the tendency to neglect distributional data and to adopt what may be termed an internal approach to prediction, in which one focuses on the constituents of the specific problem rather than on the distributional outcomes in similar cases. — Kahneman and Tversky (1979)"
Context: Economic theory of planning fallacy as potentially optimal behavior
Confidence: high
```

An economic theory paper argues that the planning fallacy may actually be *optimal* behavior — people underpredict because the ex-ante utility benefits of anticipating easy tasks outweigh the average ex-post costs of poor planning [^151^].

```
Claim: Brunnermeier et al. prove that "optimal beliefs and behavior are characterized by the planning fallacy" — optimism and the planning fallacy are not only locally but globally optimal [^151^]
Source: NBER Working Paper 14228
URL: https://www.nber.org/system/files/working_papers/w14228/w14228.pdf
Date: Unknown
Excerpt: "Our second main result is that optimal beliefs and behavior are characterized by the planning fallacy. Thus optimism and the planning fallacy are not only locally but also globally optimal... People initially underestimate the amount of work that the project will require and so do less than half the total work in the first period, on average."
Context: Economic model of rational optimism bias
Confidence: medium (theoretical model, not universally accepted)
```

**Conflict note**: The "optimal beliefs" theory is controversial. Kahneman's original interpretation treats the planning fallacy as a *bias* to be corrected, not an optimal strategy. The economic model suggests it serves anticipatory utility benefits, but this conflicts with the substantial real-world costs of project overruns (e.g., Sydney Opera House: 1400% cost overrun [^149^]).

---

### 2.2 Parkinson's Law and Work Expansion

Parkinson's Law states: "Work expands so as to fill the time available for its completion" [^57^].

```
Claim: In software development, generous deadlines create lack of urgency, perfectionism-as-procrastination, and "student syndrome" (starting at the last possible moment), causing tasks to expand to fill allocated time [^57^]
Source: Leadership.Garden
URL: https://leadership.garden/software-engineering-laws-time-estimation/
Date: 2025-08-14
Excerpt: "A feature given a two-week estimate will invariably take two weeks, filled with research, refactoring, and extensive testing. The same feature, given a hard one-week deadline, will often be completed in that week, stripped down to its essential components. The deadline itself, not the work, frequently defines the effort."
Context: Software engineering laws and time estimation
Confidence: high (well-documented phenomenon)
```

The "ninety-ninety rule" (Tom Cargill, Bell Labs, 1985) captures a related software-specific phenomenon: "The first 90 percent of the code accounts for the first 90 percent of the development time. The remaining 10 percent of the code accounts for the other 90 percent of the development time" [^150^].

```
Claim: The ninety-ninety rule, published in Communications of the ACM by Jon Bentley in 1985, highlights that the last 10% of software development — bug fixes, optimization, final adjustments — proves unexpectedly time-consuming, causing projects to take roughly 180% of initially estimated time [^150^][^152^]
Source: t2informatik / Everyday Concepts
URL: https://t2informatik.de/en/smartpedia/90-90-rule/ ; https://everydayconcepts.io/ninety-ninety-rule
Date: 2026-02-19 / Unknown
Excerpt: "The 90-90 rule is a supplement to the well-known 90-Percent-Done Syndrome, which produces an overly positive estimation of the remaining effort of a work package... The remaining 10% remaining effort estimated by employees often turns out to be an illusion in practice. The 10% remaining effort is more likely to become another 90%."
Context: Software development estimation folklore
Confidence: high
```

---

### 2.3 Cognitive Biases in Software Estimation: Anchoring, Optimism, and Expert Bias

A comprehensive review of biases in project estimating identifies multiple systematic failures [^89^]:

```
Claim: Optimism bias, anchoring bias, confirmation bias, availability bias, hindsight bias, and expert bias all significantly impact project estimates, and reference class forecasting is the primary mitigation strategy [^89^]
Source: ICEAA Online (Glauser paper)
URL: https://www.iceaaonline.com/wp-content/uploads/2024/09/ITS08-Glauser-Biases-in-Project-Estimating-paper.pdf
Date: 2024
Excerpt: "Optimism Bias: Tendency to underestimate time, costs, and risks while overestimating benefits... Anchoring Bias: Relying too heavily on initial information (the 'anchor') when making estimates... Mitigation: Use reference class forecasting to avoid over-reliance on initial estimates."
Context: Project estimating professional conference paper
Confidence: high
```

Research on software engineers specifically shows that more optimistic engineers have lower development skills, poorer recall of past effort, and higher confidence in their own predictions [^84^]:

```
Claim: More optimistic software engineers are characterized by lower development skills, poorer ability to recall effort on previous tasks, and higher confidence in prediction accuracy — but a substantial part of optimism variation seems random [^84^]
Source: Simula Research Laboratory (Jorgensen, Faugli, Gruschke)
URL: https://web-backend.simula.no/sites/default/files/publications/Jorgensen.2007.3.pdf
Date: 2007
Excerpt: "Results from four experiments suggest that more optimistic software engineers are characterized by more optimistic previous predictions, higher confidence in the accuracy of their own predictions, lower development skills, poorer ability or willingness to recall effort on previous tasks, and higher optimism scores. However, a substantial part of the variation in the level of optimism seems to be random."
Context: Peer-reviewed research on software engineer optimism
Confidence: high
```

---

### 2.4 Affective Forecasting and Time: Humans Overestimate Emotional Duration

Affective forecasting research shows that humans systematically overestimate both the intensity and duration of future emotional states [^44^][^51^][^53^].

```
Claim: People tend to overestimate the duration for which they will experience anticipated emotions — a "durability bias" — because they focus narrowly on the event (focalism) and neglect their "psychological immune system" (immune neglect) [^53^]
Source: Happier Lives Institute / Gilbert & Wilson
URL: https://www.happierlivesinstitute.org/report/affective-forecasting/
Date: 2022-02-01
Excerpt: "Despite the mind's ability to think across time, it does so in brief, fleeting snapshots, so it has trouble representing time (Gilbert & Wilson, 2009). Actual experience unfolds over far longer temporal horizons than the mind can simulate. As a result, people make routine errors in forecasting the duration of their feelings."
Context: Affective forecasting literature review
Confidence: high
```

```
Claim: Wilson and Gilbert (2003) identified two possible mechanisms for affective forecasting errors: an "initial intensity bias" (erroneous predictions about immediate emotional impact) and a "decay bias" (erroneous predictions about how quickly emotions diminish) [^51^]
Source: Northwestern University (Finkel et al.)
URL: https://faculty.wcas.northwestern.edu/eli-finkel/documents/ForecastingPageProofs8-14-07.pdf
Date: Unknown
Excerpt: "Wilson and Gilbert (2003) noted that all extant data were consistent with either or both of two possibilities: an initial intensity bias, which refers to erroneous predictions about the initial emotional impact of an event, or a decay bias, which refers to erroneous predictions about the rate that an emotional reaction diminishes over time."
Context: Academic paper on time course of affective forecasting error
Confidence: high
```

**Parallel to LLMs**: Like humans who overestimate emotional durations because they simulate in "brief, fleeting snapshots," LLMs process time through discrete token windows and may similarly fail to represent extended durations accurately.

---

### 2.5 Neuroscience of Time Perception: The Dopamine Clock

Time perception is critically mediated by dopaminergic circuits in the striatum and basal ganglia. The "internal clock" model posits that dopamine modulates clock speed [^85^][^93^][^168^].

```
Claim: Dopamine agonists speed up the internal clock (causing earlier responses), while antagonists slow it down (causing later responses) — this is the "clock pattern" observed across species [^168^]
Source: PMC / Meck (1996)
URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC3178804/
Date: Unknown
Excerpt: "DA drugs produce an immediate, scalar change in the perceived time when administered either systemically or directly into the anterior portion of the striatum; the pattern is often taken to be suggestive of a change in the speed of an internal clock... an immediate, proportional, leftward shift in perceived time is evident following systemic DA agonist administration."
Context: Pharmacological timing research review
Confidence: high
```

```
Claim: The striatum and its dopamine input from the ventral midbrain are considered central for timing on the scale of hundreds of milliseconds to seconds, with striatal cholinergic interneurons playing a complementary role [^81^]
Source: PubMed / Martel et al. (Eur J Neurosci)
URL: https://pubmed.ncbi.nlm.nih.gov/32281157/
Date: 2021
Excerpt: "The striatum and its dopamine (DA) input from the ventral midbrain are considered to be central for timing on the scale of hundreds of milliseconds and seconds. The cholinergic interneurons (ChIs) of the striatum provide an extensive local innervation, which closely interacts with striatal DA afferents."
Context: Neuroscience review of striatal timing mechanisms
Confidence: high
```

The Striatal Beat Frequency (SBF) model, developed by Matell and Meck (2000, 2004), provides the most prominent neurobiologically plausible model of interval timing [^180^][^182^]:

```
Claim: The SBF model uses cortical oscillators (pacemaker) and striatal coincidence detection to time intervals, with time-scale invariance (scalar property) emerging from network dynamics rather than being artificially constructed [^180^]
Source: PMC / Oprisan & Buhusi
URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC10103836/
Date: 2022 (published); 2023 (PMC)
Excerpt: "The SBF model is based on the neurobiologically-inspired paradigm that striatal spiny neurons integrate the activity of massive ensembles of cortical oscillators to produce coincidental beats that have periods spanning a much wider range of durations than the intrinsic periods of the cortical oscillators... The SBF model does not assume time-scale invariance but instead connects it to ubiquitous noise."
Context: Neurocomputational model of interval timing
Confidence: high
```

**Critical parallel to LLMs**: Human time perception is not computed symbolically — it emerges from dynamical neural processes (oscillators, dopamine-modulated clock speed, coincidence detection). LLMs, by contrast, have no comparable dynamical substrate. They process time as discrete tokens in static attention mechanisms, lacking the continuous, embodied, neuromodulated processes that give rise to human temporal experience.

---

### 2.6 Attention, Cognitive Load, and Time Estimation

The attentional gate model (Zakay & Block, 1996, 1997) proposes that time estimation depends on attention allocated to temporal information [^183^][^185^][^187^]:

```
Claim: The attentional gate model holds that a pacemaker emits pulses at a constant rate, but an "attentional gate" controlled by attention allocation determines how many pulses reach the cognitive counter; when attention is diverted to non-temporal tasks, fewer pulses accumulate and time is underestimated [^187^]
Source: Zakay & Block (1997), "Temporal Cognition"
URL: https://www.tu-chemnitz.de/hsw/psychologie/professuren/method/Lehre/SS_2024/S_Winkler/Zakay%20&%20Block%20(1997).pdf
Date: 1997
Excerpt: "The attentional-gate model holds that a person may divide attentional resources between attending to external events and attending to time. Attending to time opens the attentional gate, thereby allowing pulses to pass through to the cognitive counter... If a person must verbally estimate the duration, the accumulated pulse total from working memory is compared with correspondences between pulse totals and verbal (numerical) labels."
Context: Foundational cognitive psychology model of prospective timing
Confidence: high
```

Empirical studies confirm that cognitive load systematically distorts time estimation:

```
Claim: High cognitive load increases central tendency bias in estimation — participants give more weight to categorical averages when under higher cognitive load, and demanding cognitive tasks cause duration underestimation [^83^][^90^]
Source: MPRA / Cognitive constraints increase estimation biases; PMC / Motor and Cognitive Tasks on Time Estimation
URL: https://mpra.ub.uni-muenchen.de/58314/1/MPRA_paper_58314.pdf ; https://pmc.ncbi.nlm.nih.gov/articles/PMC8946194/
Date: Unknown ; 2020-07-07
Excerpt (MPRA): "cognitive load had an effect similar to that of delay, with high load condition showing more bias... participants give more weight to the category when under higher cognitive load."
Excerpt (PMC): "They tend to underestimate temporal durations with greater magnitude in the most difficult task... diverting attention away from time shortens subjective duration."
Context: Experimental psychology studies on cognitive load and time
Confidence: high
```

```
Claim: A meta-analysis found that for prospective duration judgments, active response demands (high cognitive load) produce smaller effect sizes than passive viewing, suggesting that the *type* of cognitive load matters for time distortion [^91^]
Source: George Mason University / Cognitive Load and Perception of Time
URL: https://mars.gmu.edu/bitstreams/ec760005-c5d5-4224-8c85-3443a71df677/download
Date: Unknown
Excerpt: "When making prospective duration judgments, the authors found a smaller mean effect size ratio if the response demands required active processing... It is consistently found that as the complexity of a task increases, and thus the cognitive load is thereby increased, time intervals are judged with less accuracy as a function of attention."
Context: Meta-analysis review paper
Confidence: high
```

**Parallel to LLMs**: LLMs operate under extreme "cognitive load" — every forward pass processes vast contextual windows with divided attention across thousands of tokens. If human time estimation degrades under cognitive load due to attention diversion, LLMs may similarly fail at duration estimation because their attention mechanisms are not optimized for temporal accumulation.

---

### 2.7 Metacognition and Temporal Self-Awareness

Humans possess metacognitive awareness of their own timing ability, allowing them to correct errors even without directional feedback [^118^][^124^].

```
Claim: Humans can automatically detect the direction of their own timing errors and adjust subsequent estimates, demonstrating "temporal metacognition" — and nondirectional feedback specifically improves precision [^118^]
Source: PMC / Awareness of errors and feedback in human time estimation
URL: https://pmc.ncbi.nlm.nih.gov/articles/PMC8054678/
Date: Unknown
Excerpt: "Participants in both groups demonstrated reduced central tendency and exhibited significantly greater accuracy in the redo trial temporal estimates, showcasing metacognitive ability, and an inherent capacity to adjust temporal responses despite the lack of directional information or any feedback at all."
Context: Experimental study on timing self-awareness
Confidence: high
```

ADHD research highlights the critical role of metacognition in time estimation:

```
Claim: In ADHD, "time estimation is one of the clearest examples of metacognitive distortion" — tasks may feel shorter or longer than they are, leading to under-preparation or avoidance, because "during-task monitoring" is impaired while "post-event insight" remains intact [^121^]
Source: ADHD Solutions Therapy blog
URL: https://www.adhdsolutionstherapy.com/blog/adhd-metacognition-across-lifespan
Date: 2026-02-23
Excerpt: "Time estimation is one of the clearest examples of metacognitive distortion in ADHD. Tasks may feel shorter than they are, leading to under-preparation, or longer than they are, leading to avoidance. Without accurate internal pacing, planning becomes reactive rather than predictive."
Context: Clinical psychology perspective on metacognition and time
Confidence: medium (clinical observation, not controlled experiment)
```

**Critical gap for LLMs**: LLMs currently lack any form of temporal metacognition. They cannot assess whether their own time estimates were accurate, cannot maintain an internal model of their "timing uncertainty," and cannot use past estimation errors to improve future predictions. This is a fundamental difference from humans, who — despite systematic biases — possess self-corrective metacognitive machinery.

---

### 2.8 Reference Class Forecasting: The Outside View Solution

Bent Flyvbjerg's research on mega-projects demonstrates that the "outside view" (reference class forecasting) dramatically outperforms the "inside view" (bottom-up estimation) [^147^][^149^].

```
Claim: Flyvbjerg's reference class forecasting shows that IT projects require massive uplifts to base estimates: at early stages, P80 cost uplift should be +44% and schedule uplift +75%; even at advanced stages, schedule uplift should be +26% [^147^]
Source: arXiv / Flyvbjerg, Hon, Fok (2016)
URL: https://arxiv.org/pdf/1710.09419
Date: 2016
Excerpt: "The reference class forecasts show that uncertainty reduces over time in the project estimates. At upgrade to Category C the P80 uplift should be +44% for cost and +75% for time to completion... When the project is upgraded to Category A the appropriate uplifts are +14% for cost and +26% for time to completion."
Context: Academic paper on reference class forecasting for project upgrades
Confidence: high
```

```
Claim: Flyvbjerg and Gardner found that cost estimates for projects between 1910 and 1998 were 28% short of final cost on average, with IT projects among the most prone to overruns because each project is sufficiently dissimilar to previous projects [^149^]
Source: Fast Data Science
URL: https://fastdatascience.com/ai-for-business/predict-cost-of-projects/
Date: 2025-09-15
Excerpt: "Flyvbjerg and Gardner collected a database of large projects and found that cost estimates for projects between 1910 and 1998 were 28% short of the final cost on average, with rail projects being the biggest offenders... IT projects, hosting the Olympics, and nuclear power tend to be very prone to cost overruns, because each project is sufficiently dissimilar to previous projects."
Context: AI for business / project cost prediction
Confidence: high
```

**Implication for LLMs**: LLMs trained on vast corpora have access to an implicit "reference class" of past projects and timelines. However, they appear to default to the "inside view" — generating estimates based on the specific scenario described in the prompt rather than retrieving base rates from similar historical cases. This mirrors human failure modes precisely.

---

### 2.9 LLM Temporal Reasoning Failures: Benchmark Evidence

Multiple benchmarks now document systematic LLM failures in temporal reasoning.

**TIMEBENCH** (ACL 2024) found that LLMs exhibit "substantial deficiency in their understanding of fundamental temporal expressions" [^65^]:

```
Claim: LLMs exhibit numerous computation, conversion, and comparison errors in symbolic temporal reasoning, with higher frequency of errors in combination questions highlighting multi-step reasoning as a significant challenge [^65^]
Source: ACL Anthology / TIMEBENCH
URL: https://aclanthology.org/2024.acl-long.66.pdf
Date: 2024
Excerpt: "LLMs exhibit numerous computation, conversion, and comparison errors, which suggests a substantial deficiency in their understanding of fundamental temporal expressions. Additionally, a higher frequency of errors is observed in combination questions, highlighting that multi-step reasoning continues to be a significant challenge for current models."
Context: ACL 2024 paper on temporal reasoning benchmark
Confidence: high
```

**TemporalBench** (2026) reveals that "strong numerical forecasting accuracy does not reliably translate into robust contextual or event-aware temporal reasoning" [^144^][^159^]:

```
Claim: TemporalBench shows that agent frameworks exhibit "fragmented strengths and systematic failure modes that remain largely hidden under forecasting-only benchmarks" — event descriptions are not consistently translated into actionable temporal constraints [^159^]
Source: arXiv / Weng et al. (TemporalBench)
URL: https://arxiv.org/html/2602.13272v1
Date: 2026-02-05
Excerpt: "Extensive baseline experiments show that strong numerical forecasting accuracy does not reliably translate into robust contextual or event-aware temporal reasoning; instead, existing agent frameworks exhibit fragmented strengths and systematic failure modes that remain largely hidden under forecasting-only benchmarks."
Context: Temporal reasoning benchmark for LLM agents
Confidence: high
```

```
Claim: A dominant failure mode across agent frameworks is "output control failures" — predicting sequences with incorrect horizon lengths accounts for more than 40% of errors for some agents, suggesting maintaining strict forecast length control is a fundamental challenge for LLMs [^159^]
Source: arXiv / TemporalBench
URL: https://arxiv.org/html/2602.13272v1
Date: 2026-02-05
Excerpt: "A dominant observation across all settings is that a large fraction of errors arise from output control failures rather than a lack of temporal understanding. In particular, predicting a sequence with an incorrect horizon length is the most frequent failure mode for general-purpose agents. This issue accounts for more than 40% of AgentScope's errors."
Context: Error analysis from TemporalBench experiments
Confidence: high
```

**TempoBench** reveals catastrophic failure on complex causal temporal tasks [^148^]:

```
Claim: On TempoBench's Temporal Causal Evaluation "Hard" regimen, state-of-the-art LLMs including GPT-4o achieve F1 scores of only 7.5% (TS) and 8.5% (AP) — essentially approaching chance levels on multi-step causal credit assignment [^148^]
Source: Emergent Mind / TempoBench
URL: https://www.emergentmind.com/topics/tempobench
Date: 2025-11-03
Excerpt: "TCE 'Normal' regimen: F1 (TS) = 65.6%, F1 (AP) = 59.5%; TCE 'Hard' regimen: F1 (TS) = 7.5%, F1 (AP) = 8.5%... This demonstrates a severe limitation in current LLM temporal causal credit assignment."
Context: Benchmark results for LLM temporal causal reasoning
Confidence: high
```

**TRAVELER** benchmark (2023) showed LLMs struggle with implicit and vague temporal references [^155^]:

```
Claim: LLMs perform well on explicit temporal expressions but struggle with implicit references and have the most problems with vague references; increasing event set size significantly degrades performance [^155^]
Source: arXiv / TRAVELER benchmark
URL: https://arxiv.org/html/2505.01325v1
Date: 2023-09-29
Excerpt: "While LLMs perform well on questions with explicit temporal expressions, they struggle with implicit references and have the most problems with vague references. Furthermore, increasing the size of the event set significantly declines performance."
Context: Event-based temporal reasoning benchmark
Confidence: high
```

---

### 2.10 Anchoring Bias in LLMs: Numerical Estimation

A 2024 arXiv paper directly documents anchoring bias in LLMs for numerical estimation tasks [^145^]:

```
Claim: Anchoring bias was evaluated on GPT-4o, GPT-4, and GPT-3.5 Turbo using prompts with varying anchors; each question was run 30 times per model with temperature 0.8, and datetime values were converted to decimals for statistical analysis [^145^]
Source: arXiv / Anchoring Bias in Large Language Models
URL: https://arxiv.org/html/2412.06593v1
Date: 2024-12-09
Excerpt: "In our study, we evaluate anchoring bias on three LLMs: GPT4o, GPT4, and GPT 3.5 Turbo with different settings. For each question, we ask every LLM model using a prompt composed based on the prompt template, collect and parse the answer from the LLM model to extract a numerical result."
Context: Direct measurement of anchoring bias in LLMs
Confidence: high
```

This finding directly parallels human anchoring bias, where initial numerical values disproportionately influence subsequent estimates. For LLMs, the "anchor" may be embedded in the prompt's phrasing, training data frequency, or the model's own generated text.

---

### 2.11 PERT and Structured Estimation Techniques

The Program Evaluation and Review Technique (PERT), developed by the U.S. Navy in the 1950s for the Polaris submarine project, uses three-point estimation [^120^][^122^][^126^]:

```
Claim: PERT uses three time estimates (optimistic, most likely, pessimistic) combined as (O + 4M + P) / 6 to generate weighted averages, and was specifically designed for uncertain, first-time projects like software development or research initiatives [^122^]
Source: monday.com blog / PERT guide
URL: https://monday.com/blog/project-management/pert/
Date: 2025-08-12
Excerpt: "PERT (Program Evaluation and Review Technique) is a statistical project management method that uses 3 time estimates per task to create realistic timelines that account for uncertainty... PERT works best for uncertain, first-time projects like software development or research initiatives."
Context: Project management methodology guide
Confidence: high
```

**Implication for LLMs**: PERT's structured three-point approach could be directly adapted as a prompt engineering strategy for LLMs — requiring models to generate optimistic, most likely, and pessimistic estimates rather than single-point predictions. This would force the model to consider uncertainty ranges explicitly.

---

### 2.12 AI and Machine Learning for Project Time Estimation

Emerging research explores whether AI can outperform human estimators:

```
Claim: A master's thesis found that previous projects at a life science company took on average 55.1% longer than estimated; even a simple constant-time model sometimes outperformed more complex ML models due to data scarcity [^166^]
Source: Uppsala University thesis (Bonnedahl)
URL: https://uu.diva-portal.org/smash/get/diva2:1829087/FULLTEXT01.pdf
Date: January 2024
Excerpt: "Previous projects took on average 55.1% longer to complete than estimated at the start of the project... A constant-time model (predicting that every project takes the same amount of time), had a Root Mean Squared Error (RMSE) of 5058 hours... Due to the scarcity of data, no further improvements were made."
Context: Academic thesis on AI for project management time estimation
Confidence: high
```

```
Claim: AI project management tools can analyze historical data to identify patterns humans miss, continuously recalculate forecasts, and flag at-risk milestones before they slip — but require "clean, consistent, and comprehensive historical data" [^164^]
Source: Codefinity / Project Management with AI
URL: https://codefinity.com/blog/Project-Management-with-AI---Predicting-Timelines
Date: 2025-06-10
Excerpt: "AI primarily helps project managers overcome the challenge of inaccurate timeline prediction. Traditional methods often lead to over-optimistic estimates, static plans, and delayed detection of issues... The most critical factor is having clean, consistent, and comprehensive historical data."
Context: Industry guide on AI for project timeline prediction
Confidence: medium (industry blog, but aligns with research findings)
```

**Key finding**: AI systems trained on historical project data can potentially overcome human optimism bias by using reference-class base rates. However, data scarcity and project uniqueness (especially in software/IT) remain major barriers — precisely the same challenges that make human reference class forecasting difficult.

---

## 3. Major Players, Tools, and Frameworks

### Cognitive Science & Psychology
| Name | Contribution | Relevance |
|------|-------------|-----------|
| **Daniel Kahneman & Amos Tversky** | Planning fallacy (1979), inside/outside view, anchoring bias | Foundational framework for understanding human estimation failure [^146^][^119^] |
| **Douglas Hofstadter** | Hofstadter's Law (1979) | Recursive formulation of estimation uncertainty [^49^] |
| **Bent Flyvbjerg** | Reference class forecasting, mega-project database | Demonstrated that outside-view base rates outperform expert judgment [^147^][^149^] |
| **Warren Meck & Matthew Matell** | Scalar Expectancy Theory, Striatal Beat Frequency model | Neurobiological models of interval timing [^180^][^168^] |
| **Dan Zakay & Richard Block** | Attentional gate model of prospective timing | Cognitive model linking attention allocation to time distortion [^183^][^187^] |
| **Daniel Gilbert & Timothy Wilson** | Affective forecasting, durability bias, immune neglect | How humans fail at predicting emotional duration [^51^][^53^] |
| **Tom Cargill** | Ninety-ninety rule (1985) | Software-specific formulation of effort expansion [^150^] |
| **Joel Spolsky** | Evidence-based scheduling, FogBugz | Practical software estimation methodology [^58^] |
| **Markus Brunnermeier et al.** | Economic theory of planning fallacy as optimal | Controversial claim that optimism bias is rationally optimal [^151^] |

### LLM Temporal Reasoning Benchmarks
| Benchmark | Year | Focus |
|-----------|------|-------|
| **TIMEBENCH** | 2024 | Symbolic, commonsense, and event temporal reasoning [^65^] |
| **TRAVELER** | 2023 | Event-based QA with vague/implicit/explicit temporal references [^155^] |
| **TempoBench** | 2025 | Multi-step temporal and causal reasoning via LTL automata [^148^] |
| **TemporalBench** | 2026 | Contextual and event-informed time-series tasks for agents [^144^] |

### AI/ML for Project Estimation
| Tool/Approach | Description |
|---------------|-------------|
| **Octant AI** | Oxford-derived AI for predicting construction project final cost outcomes [^191^] |
| **Reference Class Forecasting + ML** | Flyvbjerg's approach combined with machine learning for cost overrun prediction [^184^] |
| **AI-powered estimation apps (Jira integrations)** | Analyze historical sprint velocity to provide more accurate estimates [^164^] |

---

## 4. Controversies and Conflicting Claims

### 4.1 Is the Planning Fallacy a Bug or a Feature?

**Conflict**: Kahneman's original framing treats the planning fallacy as a cognitive *bias* to be corrected through outside-view techniques [^146^]. Brunnermeier et al.'s economic model argues it may be *globally optimal* — the ex-ante utility of optimistic anticipation outweighs ex-post planning costs [^151^].

**Resolution attempt**: Both views can coexist. The planning fallacy may be locally optimal for individual well-being (motivation, persistence, mood) but globally suboptimal for project outcomes (cost overruns, missed deadlines, stakeholder dissatisfaction). Kahneman focuses on predictive accuracy; the economic model focuses on utility maximization.

### 4.2 Do LLMs Exhibit "Real" Anchoring or Just Statistical Regularities?

**Conflict**: The 2024 anchoring bias paper treats LLM anchoring as a cognitive bias parallel to humans [^145^]. Skeptics might argue LLMs are simply reproducing training data patterns where initial values in prompts correlate with response distributions, without any "bias" in the psychological sense.

**Resolution attempt**: The functional equivalence matters more than the mechanism. Whether LLM "anchoring" is statistical regularity or genuine bias, the practical effect is identical: estimates are systematically skewed by initial values in prompts. This is actionable regardless of underlying mechanism.

### 4.3 Can AI Ever Solve the Estimation Problem, or Is It Inherently Unsolvable?

**Conflict**: Optimists note that AI can learn from historical data, avoid optimism bias, and apply reference class forecasting systematically [^164^][^191^]. Pessimists (following Hofstadter/Taleb) argue that "unknown unknowns" and scalable randomness make accurate estimation of complex projects fundamentally impossible [^58^][^56^].

**Evidence**: The Uppsala thesis found that even ML models with project type features performed worse than a constant-time model due to data scarcity [^166^]. Octant AI reports success in construction, where projects are more modular and historical data is richer [^191^].

**Resolution attempt**: AI estimation may be viable for *modular, repeatable* projects (construction, manufacturing) but remains unreliable for *novel, dissimilar* projects (software R&D, creative work). This aligns with Flyvbjerg's finding that IT projects are among the most prone to overruns due to project uniqueness [^149^].

### 4.4 Is Human Time Perception "Embodied" in a Way LLMs Cannot Replicate?

**Conflict**: Enactivist/embodied cognition perspectives argue that human time sense emerges from goal-directed action, sensorimotor contingencies, and affective states [^153^][^87^]. LLMs are disembodied text processors. Some researchers argue this is a fundamental limitation; others believe sufficient scale and multi-modal training can approximate embodied time sense.

**Evidence**: The SBF model's dependence on cortico-striatal circuits and dopamine modulation [^180^] has no obvious analog in transformer architectures. The attentional gate model's dependence on arousal and attention allocation [^187^] differs fundamentally from static self-attention mechanisms.

---

## 5. Gaps and Open Questions

### 5.1 Critical Research Gaps

1. **No direct human-vs-LLM estimation comparison studies**: Despite extensive literature on both human and LLM estimation failures, there are virtually no controlled experiments comparing humans and LLMs on identical time estimation tasks with matched domain expertise.

2. **Missing: "Framing effects" in LLM temporal reasoning**: The landscape scan noted that LLMs answer differently based on temporal phrasing ("more time" vs "less time"), but no published benchmark systematically tests this with controls.

3. **LLM temporal metacognition is nonexistent**: Humans can assess their own timing uncertainty and adjust [^118^]. No LLM architecture currently implements any form of temporal confidence estimation or error monitoring for duration predictions.

4. **No integration of dopamine/clock models with AI**: The striatal beat frequency model [^180^] and scalar timing theory [^165^] offer computational frameworks that have never been adapted for neural network architectures. Could dynamical oscillators improve LLM temporal reasoning?

5. **Embodied time in LLMs is unexplored**: Research on "interval timing" in animal cognition [^116^][^125^] shows that time sense is deeply tied to foraging, reward anticipation, and motor planning. LLMs have no comparable embodied grounding.

### 5.2 Open Questions

1. **Would PERT-style three-point prompting improve LLM estimates?** If humans benefit from explicit optimistic/most-likely/pessimistic estimation [^122^], would forcing LLMs to generate three estimates reduce their systematic underestimation?

2. **Can reference class prompting overcome LLM inside-view bias?** If LLMs default to scenario-specific reasoning like humans [^119^], can prompts explicitly requesting "base rates from similar historical projects" improve accuracy?

3. **Do LLMs suffer from "Parkinson's Law" in generation?** When asked to produce output "within 100 words," LLMs may expand to fill the space. Is there an equivalent of work-expansion-to-fill-time in LLM output generation?

4. **What is the relationship between token-rate and LLM "clock speed"?** Human time perception is modulated by dopamine "clock speed" [^168^]. Could LLM temperature, sampling speed, or context length serve as analogous "clock speed" modulators?

5. **Can reinforcement learning from human feedback (RLHF) correct temporal biases?** Current RLHF optimizes for helpfulness and harmlessness, not calibration. Would a dedicated "temporal calibration" reward function reduce estimation errors?

---

## 6. Summary and Recommended Deep-Dive Areas

### 6.1 Core Synthesis

Human time estimation is systematically biased by:
- **Optimism/planning fallacy**: best-case scenario fixation [^146^]
- **Anchoring**: initial values dominate [^89^]
- **Inside-view bias**: neglect of base rates [^119^]
- **Attentional mechanisms**: cognitive load distorts perceived duration [^187^]
- **Affective state**: emotions and arousal alter "clock speed" [^87^]
- **Metacognitive limitations**: poor self-monitoring of timing accuracy [^121^]

LLM time estimation is systematically flawed by:
- **Fundamental temporal expression deficiencies**: computation, conversion, comparison errors [^65^]
- **Multi-step reasoning failures**: combination and causal tasks near chance [^148^]
- **Event-conditioned reasoning gaps**: cannot translate event descriptions into temporal constraints [^159^]
- **Output control failures**: incorrect horizon lengths, scale drift [^159^]
- **Anchoring in numerical estimation**: systematically skewed by prompt values [^145^]
- **No metacognitive correction**: cannot learn from past estimation errors

**The key insight**: Both humans and LLMs default to an "inside view" — generating estimates from the specific scenario rather than from base rates. Both suffer from multiplicative error accumulation in complex tasks. Both lack reliable mechanisms for self-correcting estimation errors. However, humans possess neurobiologically grounded interval timing circuits [^180^], attentional modulation [^187^], and metacognitive awareness [^118^] that LLMs entirely lack. LLMs, conversely, can in principle access vast historical data for reference class forecasting — but current architectures do not exploit this capability effectively.

### 6.2 Recommended Deep-Dive Areas

1. **"Outside-view prompting" for LLMs**: Systematically test whether prompts requiring explicit base-rate retrieval, historical comparison, and three-point estimation improve LLM time predictions.

2. **Neural oscillators for AI timing**: Explore whether incorporating dynamical neural oscillators (inspired by SBF models) into LLM architectures could provide genuine interval timing capability.

3. **Temporal metacognition in LLMs**: Develop architectures that can estimate their own temporal uncertainty, track past estimation errors, and adjust predictions accordingly.

4. **Human-LLM estimation comparison experiments**: Design controlled studies where humans and LLMs estimate identical software tasks, measuring both accuracy and confidence calibration.

5. **Dopamine-inspired neuromodulation for transformers**: Investigate whether adaptive "clock speed" mechanisms (adjusting effective processing rate based on task urgency or predicted reward) could improve LLM temporal reasoning.

6. **Reference class retrieval mechanisms**: Build explicit retrieval components that fetch similar historical project timelines from databases before generating estimates, forcing LLMs to use the outside view.

---

*Document compiled from 28+ independent web searches across cognitive psychology, neuroscience, software engineering, project management, and AI/ML literatures.*

*Last updated: Research session Step 9/60*
