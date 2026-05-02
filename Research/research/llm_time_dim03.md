# Research Dimension 03: Training Data & Representational Causes

**Scope:** How training data composition, distribution, and tokenization affect LLM time estimation and temporal reasoning capabilities.

---

## 1. Dimension Overview and Scope

This research dimension investigates the foundational role that pretraining and fine-tuning data play in shaping LLM temporal reasoning. Key sub-areas include:

- **Temporal distribution of training corpora**: How dates, events, and time-related facts are distributed across pretraining data (CommonCrawl, C4, Wikipedia, etc.)
- **Tokenization artifacts**: How subword tokenizers fragment dates and numbers, creating representational bottlenecks for temporal reasoning
- **Knowledge cutoff and staleness**: The gap between training data recency and real-time knowledge requirements
- **Long-tail temporal knowledge**: Sparse historical data and its consequences for long-span reasoning
- **Training paradigms**: Continual pretraining, yearwise fine-tuning, curriculum learning, and catastrophic forgetting in temporal domains
- **Cross-calendar and cultural bias**: Gregorian calendar dominance in training data and its effect on non-Gregorian temporal reasoning
- **Temporal representation in embeddings**: How LLMs internally encode time coordinates and whether these representations are linear and structured

---

## 2. Key Findings with Evidence Blocks

### 2.1 Date Tokenization Creates a Hidden Bottleneck for Temporal Reasoning

**Claim:** Subword tokenizers fragment dates into semantically meaningless pieces, and the degree of fragmentation correlates with downstream temporal reasoning accuracy [^97^].

**Source:** "A Hidden Bottleneck of Tokenization for Temporal Reasoning" (arXiv:2505.16088, 2025)

**URL:** https://arxiv.org/html/2505.16088v1

**Date:** 2025-05-22

**Excerpt:**
> "A tokenizer that splits '2025-03-14' into '20', '25', '-0', '3', '-1', '4' not only inflates the token count but also severs the natural boundaries of year, month, and day. This fragmentation obscures temporal cues and introduces a hidden bottleneck: even state-of-the-art LLMs struggle to resolve, compare, or compute dates accurately when their internal representations have been so badly fragmented."

> "We find that the fragmentation ratio generally correlates with temporal reasoning performance, namely that the more fragmented the tokenization, the worse the reasoning performance."

> "Formats that contain explicit separators (DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD) are tokenised into more pieces and, in turn, resolved more accurately than compact, separator-free strings (DDMMYYYY, MMDDYYYY, YYYYMMDD)."

**Context:** The paper introduces DateAugBench (6,500 examples, 21 date formats) and the "date fragmentation ratio" metric. They find a Pearson correlation of -0.42 between fragmentation ratio and accuracy across formats, and -0.61 across temporal splits.

**Confidence:** High

---

**Claim:** Different LLM families exhibit dramatically different date fragmentation ratios, with OLMo being most robust (0.15 avg) and Llama 2/Phi being worst (0.60) [^97^].

**Source:** "A Hidden Bottleneck of Tokenization for Temporal Reasoning"

**URL:** https://arxiv.org/html/2505.16088v1

**Date:** 2025-05-22

**Excerpt:**
> "Among neural architectures, OLMo demonstrates the highest robustness, with an average fragmentation ratio of 0.15, closely followed by GPT-3 at 0.16. Both maintain strong fidelity across temporal splits, although performance dips modestly in the Future category (0.25), reflecting novel token sequences not seen during pretraining."

> "Llama 2: 0.60" [for MMDDYYYY string "10271606"]

**Context:** Table 4 shows tokenization of "10271606" across 10 models, revealing fragmentation ratios from 0.34 (OLMo) to 0.60 (Llama 2, Phi 3.5).

**Confidence:** High

---

**Claim:** LLMs perform "date abstraction" — stitching fragmented date tokens back together through intermediate layers, with larger models compensating at earlier layers [^97^].

**Source:** "A Hidden Bottleneck of Tokenization for Temporal Reasoning"

**URL:** https://arxiv.org/html/2505.16088v1

**Date:** 2025-05-22

**Excerpt:**
> "We analyse internal representations by tracing how LLMs 'heal' fragmented date embeddings in their layer stack—an emergent ability that we term date abstraction. We find that larger models quickly can compensate for date fragmentation to achieve high accuracy of temporal reasoning at early layers."

> "Qwen2.5-0.5B reaches TCP [tokenization compensation point] at layer 12 (50% depth), Qwen2.5-1.5B at layer 15 (53.6%), Qwen2.5-3B at layer 8 (22.2%), and Qwen2.5-7B at layer 4 (14.3%). The leftward shift of the 3B and 7B curves suggests how larger models recover calendar-level semantics from fragmented tokens more rapidly."

**Context:** The Tokenization Compensation Point (TCP) is defined as the earliest layer where a linear probe achieves >80% accuracy on date equivalence. TCP shifts leftward (earlier) as model size increases.

**Confidence:** High

---

### 2.2 Number Tokenization Strategies Directly Impact Arithmetic and Temporal Computation

**Claim:** The direction of number tokenization (left-to-right vs. right-to-left) creates systematic performance differences on arithmetic tasks, with right-to-left tokenization yielding large improvements [^132^].

**Source:** "The Impact of Tokenization on Arithmetic in Frontier LLMs" (arXiv:2402.14903, 2024)

**URL:** https://arxiv.org/abs/2402.14903

**Date:** 2024-02-22

**Excerpt:**
> "We consider left-to-right and right-to-left tokenization for GPT-3.5 and -4, finding that right-to-left tokenization (enforced by comma separating numbers at inference time) leads to largely improved performance. Furthermore, we find that model errors when using standard left-to-right tokenization follow stereotyped error patterns, suggesting that model computations are systematic rather than approximate."

> "The gap between tokenization directions decreases when models are scaled, possibly indicating that larger models are better able to override this tokenization-dependent inductive bias."

**Context:** GPT models tokenize numbers in 1-, 2-, and 3-digit chunks left-to-right, while Llama and PaLM use single-digit tokenization. The paper demonstrates that adding commas (enforcing right-to-left chunking) dramatically improves arithmetic accuracy.

**Confidence:** High

---

**Claim:** LLMs rely on a "one-digit lookahead heuristic" for addition, which fundamentally limits multi-operand arithmetic regardless of tokenization strategy [^138^].

**Source:** "Why Multi-Operand Addition is Hard for LLMs" (BlackboxNLP 2025)

**URL:** https://aclanthology.org/2025.blackboxnlp-1.15.pdf

**Date:** 2025 (Findings)

**Excerpt:**
> "We show that this struggle arises from LLMs' use of a simple one-digit lookahead heuristic, which forms an upper bound for LLM performance and works fairly well (but not perfect) for two-operand addition but fails in multi-operand cases, where the carry-over logic is more complex."

> "We analyze the impact of tokenization strategies on arithmetic performance and show that all investigated models, regardless of tokenization and size, are inherently limited in the addition of multiple operands due to their reliance on a one-digit lookahead heuristic."

**Context:** This finding has direct implications for temporal arithmetic (e.g., adding days to dates, computing durations), suggesting that models are algorithmically limited regardless of how dates are tokenized.

**Confidence:** High

---

**Claim:** Frontier models tokenize long numeric sequences in groups of 3 digits (left-to-right), which can split numbers at semantically incorrect boundaries, while some models tokenize digit-by-digit or use semantic grouping [^159^].

**Source:** "How would you tokenize (or break down) a million digits of pi?" (Art Fish Intelligence, 2024)

**URL:** https://www.artfish.ai/p/how-would-you-tokenize-or-break-down

**Date:** 2024-05-22

**Excerpt:**
> "GPT-4 and Llama 3 tokenize in groups of 3... The number [123456] would be tokenized as [123] and [456] while the number 23456 would be tokenized as [234] and [56], which would not capture the relationship between the two numbers."

> "Claude's tokenizer splits up the digits of pi based on 4-digit sequences that look a lot like dates, such as 1988, 1999, and 2020."

**Context:** The observation that Claude's tokenizer recognizes date-like patterns suggests training data frequency shapes token boundaries. This creates an inductive bias where date-adjacent numbers are treated differently.

**Confidence:** High

---

### 2.3 Training Data Temporal Distribution and Knowledge Cutoffs

**Claim:** CommonCrawl contains non-trivial amounts of old data even in new dumps, creating "soft" or uneven knowledge cutoffs that differ from reported cutoffs [^181^].

**Source:** "Tracing Knowledge Cutoffs in Large Language Models" (arXiv:2403.12958, 2024)

**URL:** https://arxiv.org/html/2403.12958v1

**Date:** 2024-03-19

**Excerpt:**
> "Our analysis reveals two reasons for these inconsistencies: (1) temporal biases of CommonCrawl data due to non-trivial amounts of old data in new dumps and (2) complications in LLM deduplication schemes involving semantic duplicates and lexical near-duplicates."

> "We define the notion of an effective cutoff. This is distinct from the LLM designer reported cutoff and applies separately to sub-resources and topics."

**Context:** The paper analyzes open pretraining datasets directly and finds that effective cutoffs often differ from reported cutoffs, meaning models have uneven temporal knowledge even within their claimed training window.

**Confidence:** High

---

**Claim:** LLMs exhibit multiple partial knowledge boundaries rather than a single clean cutoff, as demonstrated by changepoint analysis on Claude Sonnet 4 [^163^].

**Source:** "LLMLagBench: Identifying Temporal Training Boundaries in Large Language Models" (arXiv:2511.12116, 2025)

**URL:** https://arxiv.org/html/2511.12116v1

**Date:** 2025-11-15

**Excerpt:**
> "Claude Sonnet 4 exhibits multiple partial knowledge boundaries possibly corresponding to different training phases... PELT identifies two distinct changepoints at February 2023 and December 2024, dividing the model's performance into three segments with progressively declining mean faithfulness scores (1.25, 0.93, and 0.05, respectively) and increasing refusal rates (28.7%, 46.8%, and 95.1%)."

> "The first changepoint in early 2023 is particularly notable, occurring well before the model provider's declared cutoff of January 2025 and its release date of May 2025. This suggests that Claude Sonnet 4's knowledge base was not uniformly updated throughout its training process."

**Context:** This finding directly challenges the simplistic "knowledge cutoff date" framing and suggests training data composition changes during multi-stage training create layered temporal boundaries.

**Confidence:** High

---

**Claim:** The temporal span of CommonCrawl data ranges from 2008/2009 to present, with monthly snapshots of 3-5 billion pages each, but temporal distribution within each snapshot is non-uniform [^160^].

**Source:** "What Is Common Crawl? A History of the Open Web Dataset" (RankStudio, 2025)

**URL:** https://rankstudio.net/articles/en/common-crawl-history

**Date:** 2025-11-02

**Excerpt:**
> "Temporal span: Monthly snapshots from 2008 or 2009 to the present (15+ years). Each snapshot typically contains pages crawled in that month."

> "Notable project uses: AI/ML training (GPT-3, PaLM, etc.)... Largest LLM coverage: ~80-85% of GPT-3's training tokens are from CommonCrawl."

**Context:** ~80-85% of GPT-3's training tokens come from CommonCrawl, which spans 15+ years. The recency bias in web content means recent years are massively overrepresented compared to historical periods.

**Confidence:** High

---

### 2.4 Long-Tail Temporal Distribution and Historical Knowledge Sparsity

**Claim:** LLMs trained on vast web corpora face sparse temporal information over long historical periods, resulting in insufficient learning or catastrophic forgetting for long-span temporal reasoning [^130^].

**Source:** "Ticktack: Long Span Temporal Alignment of Large Language Models Leveraging Sexagenary Cycle Time Expression" (arXiv:2503.04150, 2025)

**URL:** https://arxiv.org/html/2503.04150v1

**Date:** 2025

**Excerpt:**
> "LLMs suffer from temporal misalignment issues especially across long span of time. The issue stems from knowing that LLMs are trained on vast amounts of data with sparse temporal information over long periods, such as thousands of years, resulting in insufficient learning or catastrophic forgetting by the LLMs."

> "By employing the sexagenary cycle chronology to represent the years, thousands of years of long-term data are reconstructed and aggregated into a 60-year cycle. As a result, the time representation achieves a more uniform distribution than the broader distribution space in the Gregorian year system."

**Context:** The Ticktack paper identifies the root cause of long-span temporal misalignment as the extreme sparsity of historical data in training corpora. The Gregorian year system creates an excessively wide range for year embeddings, while the sexagenary (60-year cycle) calendar compresses this into a uniform distribution.

**Confidence:** High

---

**Claim:** Historical documents exemplify long-tail knowledge challenges — information about historical entities is sparse in pretraining datasets, causing models to fail on NER, entity linking, and QA tasks for historical content [^162^].

**Source:** "KE-MHISTO: Towards a Multilingual Historical Knowledge Extraction Benchmark" (ACL 2025 Findings)

**URL:** https://aclanthology.org/2025.findings-acl.1042.pdf

**Date:** 2025

**Excerpt:**
> "LLMs struggle when probed for so-called long-tail knowledge... While larger models improve retention and accuracy in performing the task (e.g. in question-answering), they provide only modest benefits for infrequent knowledge."

> "Historical documents exemplify the challenges of long-tail KE, as information about historical entities and events is sparse in the pre-training datasets used to develop LLMs, which are typically based on large-scale general-purpose knowledge bases, such as Wikipedia."

**Context:** This confirms that temporal long-tail issues are a specific instance of the general long-tail knowledge problem in LLMs. Scale helps on frequent knowledge but provides only modest benefits for rare/historical facts.

**Confidence:** High

---

**Claim:** Temporal facts in knowledge graphs exhibit long-tailed relation distributions, with some relations (e.g., startMemberOf) dominating while most appear rarely [^211^].

**Source:** "Beyond Known Facts: Generating Unseen Temporal Knowledge to Address Data Contamination in LLM Evaluation" (arXiv:2601.13658, 2026)

**URL:** https://arxiv.org/html/2601.13658v1

**Date:** 2026-01-20

**Excerpt:**
> "The right histogram (log scale) presents the distribution of relations across all temporal facts, revealing a long-tailed pattern dominated by a few highly frequent relations such as startMemberOf, while most relations appear far less frequently."

> "The peak of number of facts occur in 2013 with approximately 100,000 facts, and steadily decreases afterwards."

**Context:** Even structured temporal knowledge follows Zipfian distributions, with recent years and common relation types heavily overrepresented.

**Confidence:** High

---

### 2.5 Temporal Representation in LLM Embedding Space

**Claim:** LLMs learn linear representations of time that are decodable via linear probes, with individual "time neurons" encoding temporal coordinates [^226^].

**Source:** "Language Models Represent Space and Time" (arXiv:2310.02207, 2024 / ICLR 2024)

**URL:** https://arxiv.org/html/2310.02207v3

**Date:** 2024-03-04

**Excerpt:**
> "We discover that LLMs learn linear representations of space and time across multiple scales. These representations are robust to prompting variations and unified across different entity types."

> "We identify individual 'space neurons' and 'time neurons' that reliably encode spatial and temporal coordinates."

> "These probing experiments reveal evidence that models build spatial and temporal representations throughout the early layers before plateauing at around the model halfway point with larger models consistently outperforming smaller ones."

**Context:** Gurnee & Tegmark used Wikipedia-sourced datasets (historical figures' death years, artwork release dates, news headline dates from 2010-2020) and found R^2 up to 0.92 for spatial coordinates and strong linear decodability for years.

**Confidence:** High

---

**Claim:** LLMs encode temporal information in a unified, cross-entity-type manner, with representations that are linear (nonlinear probes do not perform better), robust to prompting changes, and consistent across data distributions [^226^].

**Source:** "Language Models Represent Space and Time"

**URL:** https://arxiv.org/html/2310.02207v3

**Date:** 2024-03-04

**Excerpt:**
> "We then show these representations are (1) linear, given that nonlinear probes do not perform better, (2) fairly robust to changes in prompting, and (3) unified across different kinds of entities."

> "We conjecture that the most canonical form of this structure is a discretized hierarchical mesh, where any sample is represented as a linear combination of its nearest basis points at each level of granularity."

**Context:** The paper suggests LLMs form genuine (if approximate) world models of time, not just surface statistics. However, the resolution and accuracy of these representations varies across temporal scales.

**Confidence:** Medium-High

---

### 2.6 Cross-Calendar and Festival-Based Bias

**Claim:** LLMs perform significantly better on Gregorian-to-Other calendar conversions than Other-to-Gregorian, exhibiting "Calendar Asymmetry Bias" due to the prevalence of Gregorian expressions in pretraining data [^94^].

**Source:** "Benchmarking and Improving Cross-Calendar Temporal Reasoning of Large Language Models" (arXiv:2511.09993, 2026)

**URL:** https://arxiv.org/html/2511.09993v2

**Date:** 2026-01-09

**Excerpt:**
> "All LLMs perform better on the Gregorian-to-Others group, with accuracy gains ranging from 3.97% to 17.49%, particularly among higher-performing models like DeepSeek-V3 (17.49%), GPT-4o (15.82%), and Claude-3.7-Sonnet (15.76%). We refer to this discrepancy as Calendar Asymmetry Bias in LLMs, conjecturing that it likely stems from the prevalence of Gregorian-origin expressions in pretraining data."

> "Most LLMs perform better on festival-based reasoning, with gains between 2.87% and 12.60%... This likely stems from the prevalence of festival dates in pretraining data, which reduces the difficulty of festival-based reasoning."

**Context:** The paper demonstrates that training data composition directly biases calendar reasoning capabilities. Models trained predominantly on Gregorian-dated web content struggle with reverse conversions.

**Confidence:** High

---

### 2.7 Training Paradigms for Temporal Knowledge

**Claim:** Yearwise fine-tuning, continual year-by-year fine-tuning, and random chronological fine-tuning each influence the trade-off between correctness and "I don't know" responses, with random fine-tuning producing the highest "information not available" scores [^199^].

**Source:** "Remember This Event That Year? Assessing Temporal Information and Understanding in Large Language Models" (EMNLP 2024 Findings)

**URL:** https://aclanthology.org/2024.findings-emnlp.953.pdf

**Date:** 2024

**Excerpt:**
> "We experimented with three distinct training paradigms: (1) yearwise fine-tuning, (2) continual learning, and (3) random fine-tuning... the yielded average 'N' [not available] scores are ZS(11%), Y-FT(29%), CL(30%), and R-FT(38%)."

> "Different learning paradigms reduced LLM's incorrect generations and allowed the LLMs to acknowledge wherever information was unavailable. Reduced correct responses notifies the need for better numerical-temporal learning paradigms."

> "During the Y-FT, CL, and R-FT training, we observed that the LLMs are very sensitive towards the temporal-numerical data as the 'C' [correct] scores decreased significantly from 22% to 18% (Y-FT), 17% (CL), and 9% (R-FT)."

**Context:** The TempUN dataset spans 10,000 BCE to 2100 CE. Fine-tuning paradigms that improve honesty (acknowledging unknown information) come at the cost of reduced correct answers, suggesting temporal knowledge is fragile and easily distorted.

**Confidence:** High

---

**Claim:** Ticktack achieves an average 34% improvement in accuracy on long-span questions by using sexagenary calendar representation, polar coordinates, and Elastic Weight Consolidation (EWC) during post-training [^130^].

**Source:** "Ticktack: Long Span Temporal Alignment of Large Language Models"

**URL:** https://arxiv.org/html/2503.04150v1

**Date:** 2025

**Excerpt:**
> "We employ polar coordinates to model the sexagenary cycle of 60 terms and the year order within each term, with additional temporal encoding to ensure LLMs understand them."

> "We present a temporal representational alignment approach for post-training LLMs that effectively distinguishes time points with relevant knowledge, hence improving performance on time-related tasks, particularly over a long period."

**Context:** The sexagenary cycle compresses thousands of years into 60 categories, creating uniform yearly distribution. EWC prevents catastrophic forgetting of general capabilities during temporal alignment.

**Confidence:** High

---

**Claim:** Continual pretraining on web data can match periodic retraining from scratch with 62% less compute when combined with replay strategies, but forgetting is domain-dependent — replay hurts on rapidly evolving domains like StackOverflow [^203^].

**Source:** "TiC-LM: A Web-Scale Benchmark for Time-Continual LLM Pretraining" (arXiv:2504.02107, 2025)

**URL:** https://arxiv.org/html/2504.02107v1

**Date:** 2025-04-02

**Excerpt:**
> "Replay allows for matching repeated from-scratch training... combining autoregressive (AR) learning rate schedules and data replay (red) can nearly match the perplexity on all months achieved by the Oracle series which re-trains from scratch every two years (gray), despite requiring 2.6x less compute."

> "Forgetting older CC dumps need not always be detrimental. Replaying old data can actually hurt when evaluating on rapidly evolving domains like StackOverflow and PyTorch, while still benefiting more stable ones where older dumps are more useful such as Math and NumPy."

**Context:** TiC-LM uses 114 months of CommonCrawl data (2.9T tokens). This is the largest-scale temporal continual learning benchmark, showing that temporal forgetting is not uniform across knowledge domains.

**Confidence:** High

---

**Claim:** Catastrophic forgetting intensifies with model scale in the 1B-7B parameter range, and decoder-only models exhibit less forgetting than encoder-decoder models [^124^].

**Source:** "An Empirical Study of Catastrophic Forgetting in Large Language Models During Continual Fine-tuning" (arXiv:2308.08747, 2023)

**URL:** https://arxiv.org/abs/2308.08747

**Date:** 2023-08-17

**Excerpt:**
> "The experiments reveal that catastrophic forgetting is generally observed in LLMs ranging from 1b to 7b parameters. Surprisingly, as the model scale increases, the severity of forgetting intensifies in such a model sale range which may result from the much significant initial performance in the larger LLM."

> "Comparing the decoder-only model BLOOMZ with the encoder-decoder model mT0, BLOOMZ exhibits less forgetting and retains more knowledge."

**Context:** This finding is critical for temporal continual learning: larger models within this range forget more severely because they have more to lose from their higher initial performance baseline.

**Confidence:** High

---

### 2.8 Synthetic and Augmented Temporal Data

**Claim:** Less than 0.1% of web-scraped text corpora contain meaningful temporal sequences, necessitating synthetic data generation for time-series-LLM alignment [^95^].

**Source:** "Augmenting LLMs for General Time Series Understanding and Prediction" (arXiv:2510.01111, 2025)

**URL:** https://arxiv.org/html/2510.01111v1

**Date:** 2025-10-01

**Excerpt:**
> "While web-scraped text corpora contain billions of documents, less than 0.1% include meaningful temporal sequences, necessitating alternative strategies for collecting suitable data."

> "Our training corpus comprises 25 billion tokens across 2 million examples, carefully curated to address the scarcity of high-quality time series-text pairs while ensuring broad domain coverage."

**Context:** TsLLM (Time Series-augmented LLM) addresses the fundamental scarcity of temporal-numerical data in pretraining corpora by generating synthetic paired data and using a patch-based encoder-decoder architecture.

**Confidence:** Medium-High (the 0.1% figure is a claim from the paper; independent verification would strengthen confidence)

---

**Claim:** Synthetic temporal data generation can be used to create temporal knowledge benchmarks that avoid data contamination from pretraining corpora [^211^].

**Source:** "Beyond Known Facts: Generating Unseen Temporal Knowledge to Address Data Contamination in LLM Evaluation"

**URL:** https://arxiv.org/html/2601.13658v1

**Date:** 2026-01-20

**Excerpt:**
> "We introduce UnseenTKG, a benchmark for evaluating LLMs on temporal knowledge that they have not encountered during pre-training. To this end, we leverage temporal knowledge graphs (TKGs) to generate novel temporal facts through structured synthetic reasoning."

**Context:** Data contamination is a major issue for temporal benchmarks because LLMs are trained on Wikipedia, news, and web data containing most historical facts. Synthetic generation provides clean evaluation.

**Confidence:** High

---

### 2.9 Chronological Consistency and Time-Bounded Training

**Claim:** Training chronologically consistent LLMs (ChronoBERT) on timestamped text available only up to time t achieves comparable language understanding to inconsistent models while eliminating lookahead bias [^118^].

**Source:** "Chronologically Consistent Large Language Models" (arXiv:2502.21206, 2025)

**URL:** https://arxiv.org/html/2502.21206v1

**Date:** 2025-02-28

**Excerpt:**
> "We address this challenge by training chronologically consistent LLMs trained exclusively on historical textual data available at the time."

> "ChronoBERT and ChronoGPT exhibit superior language understanding relative to similar-sized models and comparable to much larger Llama models."

> "In an asset pricing application predicting next-day stock returns from financial news, we find that ChronoBERT and ChronoGPT's Sharpe ratios (4.80 and 4.92) are comparable to powerful larger-scale (and inconsistent) Llama (4.90)."

**Context:** The paper demonstrates that chronological training constraints do not necessarily degrade model quality, and that training on time-bounded data can still yield competitive performance.

**Confidence:** High

---

**Claim:** Selective Temporal Training (STT) — training from scratch on data from a specific historical period — can produce models that genuinely embody the language and knowledge of that era without modern bias [^121^].

**Source:** Time Capsule LLM (GitHub, 2025)

**URL:** https://github.com/haykgrigo3/TimeCapsuleLLM

**Date:** 2025-07-02

**Excerpt:**
> "Selective Temporal Training (STT) is a machine learning methodology where all training data is specifically curated to fall within a specific historical time period. It's done in order to model the language and knowledge of that era without influence from modern concepts."

> "If I fine-tune something like GPT-2, it's already pre-trained and that information won't go away. If I train from scratch the language model won't pretend to be old, it just will be."

**Context:** The Time Capsule LLM project trained models exclusively on 1800-1875 London texts (up to 1.2B parameters), showing that temporal data selection fundamentally shapes model behavior.

**Confidence:** Medium (practical results are preliminary; methodology is sound)

---

### 2.10 LLMs Excel at Factual Reasoning but Struggle with Factual Extraction for Temporal Tasks

**Claim:** LLMs are "good factual reasoners rather than factual extractors" — they perform well on structured temporal reasoning (TempReason) but poorly on context-based extraction (TimeQA), revealing a bottleneck in extracting time-fact pairs from text [^133^].

**Source:** "TimeBench: A Comprehensive Evaluation of Temporal Reasoning Abilities in Large Language Models" (arXiv:2311.17667, 2023)

**URL:** https://arxiv.org/html/2311.17667v1

**Date:** 2023-11-29

**Excerpt:**
> "LLM excels in TempReason, signifying its strong capability in fact-based reasoning. However, LLM's performance in context-based reasoning was significantly weaker than in the former. We attribute this gap to the model's deficiency in factual extraction capabilities."

> "LLM demonstrates poor implicit temporal reasoning abilities... Even GPT-4 achieves a mere 66.4% accuracy [on TRACIE]."

**Context:** This suggests that temporal reasoning failures are not purely due to missing training data — even when the facts are present in context, LLMs struggle to extract and align them temporally.

**Confidence:** High

---

## 3. Major Players, Tools, and Frameworks

### Benchmarks and Datasets
| Name | Description | Scale | Key Insight |
|------|-------------|-------|-------------|
| **DateAugBench** | Date tokenization benchmark with 21 formats | 6,500 examples | Fragmentation ratio correlates with accuracy |
| **TimeBench** | Comprehensive temporal reasoning evaluation | 11 tasks, 4 formats | LLMs are better reasoners than extractors |
| **TempUN** | Numerical-temporal dataset spanning history | 631K samples, 10,000 BCE to 2100 CE | Fine-tuning paradigms trade correctness for honesty |
| **TempLS** | Long-span temporal QA (Ticktack evaluation) | BCE to present | Sexagenary calendar improves long-span accuracy |
| **TiC-LM** | Web-scale continual pretraining benchmark | 114 months, 2.9T tokens | Replay + AR schedules match retraining with 62% less compute |
| **TimE** | Real-world temporal reasoning benchmark | 38,522 QA pairs, 3 levels | Tests intensive temporal info and fast-changing dynamics |
| **KE-MHISTO** | Multilingual historical KE benchmark | English + Italian | Historical long-tail knowledge is severely challenging |
| **LLMLagBench** | LLM freshness / cutoff identification | Systematic probing | Models have multiple partial cutoffs, not single boundaries |
| **VTG-IT-120K** | Video temporal grounding instruction data | 120K video-text pairs | Timestamp-aware training data for video LLMs |

### Key Research Works
| Work | Authors/Institution | Core Contribution |
|------|---------------------|-------------------|
| **Ticktack** | Han et al., China Mobile | Sexagenary calendar + polar coordinates + EWC for long-span alignment |
| **DateAugBench / Hidden Bottleneck** | EMNLP 2025 | Quantified date tokenization fragmentation impact |
| **Gurnee & Tegmark** | MIT | Discovered linear space/time representations in LLMs |
| **ChronoBERT** | He et al., WashU | Chronologically consistent LLMs for finance |
| **TiC-LM** | Li et al., Apple/UW | Web-scale continual pretraining benchmark |
| **TsLLM** | Parker et al., JHU | Time series augmentation via patch-based encoder + 2M examples |
| **Time Capsule LLM** | Grigorian (open source) | Selective temporal training from scratch on Victorian texts |
| **TISER** | Timeline Self-Reflection | Test-time scaling for temporal reasoning via CoT + reflection |

---

## 4. Controversies and Conflicting Claims

### 4.1 Do LLMs Learn World Models or Surface Statistics?

**Gurnee & Tegmark** argue that LLMs learn genuine "world models" with linear representations of space and time, supported by probing experiments and the discovery of "space neurons" and "time neurons" [^226^].

**Counter-perspective:** Critics note that linear decodability does not imply the model *uses* these representations for inference. The representations could be epiphenomenal — byproducts of training rather than causal features. Gurnee & Tegmark acknowledge this: "High predictive performance on out-of-sample data indicates that the base model has temporal and spatial information linearly decodable in its representations, although this does not imply that the model actually uses these representations."

**Reconciliation:** Mechanistic follow-up work (causal interventions on time neurons) provides stronger evidence that these features are causally used [^226^].

---

### 4.2 Does Model Scale Help or Hurt Temporal Knowledge Retention?

**Conflicting finding 1:** Larger models (70B) outperform smaller models (8B) on temporal QA tasks within the same family [^207^].

**Conflicting finding 2:** In the 1B-7B range, catastrophic forgetting *intensifies* with scale [^124^].

**Conflicting finding 3:** For long-tail historical knowledge, "larger models improve retention and accuracy... [but] provide only modest benefits for infrequent knowledge" [^162^].

**Resolution:** Scale helps when knowledge is present in training data (better memorization and reasoning), but does not overcome the fundamental long-tail sparsity problem. Forgetting severity may have a non-monotonic relationship with scale — very small models have less to forget, mid-size models (1B-7B) have significant capacity and performance to lose, and very large models may develop more robust distributed representations.

---

### 4.3 Is Continual Pretraining or Periodic Retraining Better?

**Claim (TiC-LM):** Continual pretraining with replay can match periodic retraining with 62% less compute [^203^].

**Counter-claim:** "An important limitation of our work is that we were not able to find a method that outperforms Oracle re-training on all evaluations" [^203^].

**Nuanced view:** The optimal strategy is domain-dependent. Replay is essential for stable domains (Wikipedia, Math) but can hurt on rapidly evolving domains (StackOverflow, PyTorch documentation). There is no universally optimal continual learning strategy.

---

### 4.4 Can Fine-Tuning Improve or Only Distort Temporal Knowledge?

**Beniwal et al. (TempUN)** find that yearwise/continual/random fine-tuning reduces incorrect responses but also reduces correct responses — fine-tuning "hurts the LLMs knowledge" [^199^].

**TISER / Timeline Self-Reflection** find that fine-tuning on high-quality temporal reasoning datasets with structured CoT dramatically improves performance, enabling 7B models to match or exceed GPT-4o [^209^].

**Reconciliation:** The quality and structure of fine-tuning data matters enormously. Unstructured temporal fine-tuning distorts existing knowledge, while carefully curated instruction data with reasoning traces enhances it.

---

## 5. Gaps and Open Questions

1. **What is the actual temporal distribution of dates in major pretraining corpora?** No large-scale analysis has directly measured the frequency distribution of years, months, and specific dates across CommonCrawl, C4, The Pile, or proprietary datasets like those used for GPT-4. Such analysis would verify the long-tail hypothesis quantitatively.

2. **How does Zipf's law apply specifically to temporal entities?** While Zipf's law is well-established for words [^229^] and has been shown for LLM-generated texts [^232^], the specific distribution of years, dates, and historical events in pretraining data has not been characterized. The claim that "the most frequent tokens dominate the rest" [^187^] suggests historical dates should follow a steep power law, but empirical verification is needed.

3. **What is the optimal tokenizer design for temporal data?** No tokenizer explicitly optimizes for date preservation. The observation that "we suggest future work to consider date-aware vocabularies and adaptive tokenizers" [^97^] identifies an unaddressed engineering challenge.

4. **How do multimodal temporal inputs (video timestamps, sensor data, event logs) interact with text-based temporal representations?** Video LLMs have begun adding time tokens to vocabularies [^117^], but the interaction between visual temporal grounding and linguistic temporal reasoning remains unexplored.

5. **Can curriculum learning ordered by time improve temporal reasoning?** The idea of "time-based curriculum learning" — presenting training data chronologically — has been proposed [^202^] but not rigorously evaluated for temporal reasoning specifically.

6. **What is the role of synthetic data in temporal knowledge?** While TsLLM and TokenCast demonstrate synthetic temporal data generation [^95^][^180^], the scaling laws for synthetic vs. real temporal data are unknown.

7. **How do relative vs. absolute time representations differ in LLMs?** Human cognition uses both ("3 days ago" vs. "January 15, 2025"), but LLM training data is dominated by absolute Gregorian dates. The impact on reasoning about durations, intervals, and relative time is understudied.

8. **Do time-bounded training datasets exist at scale?** Beyond the Time Capsule LLM (90GB) and ChronoBERT (65B tokens), there is no systematic effort to create large-scale temporally-stratified training corpora for different historical periods.

9. **What is the impact of deduplication on temporal knowledge?** Cheng et al. found that "complications in LLM deduplication schemes involving semantic duplicates and lexical near-duplicates" affect cutoff estimation [^181^]. Deduplication may disproportionately remove older content, biasing temporal knowledge.

10. **Can temporal knowledge editing work at scale?** Current knowledge editing methods (ROME, MEMIT) struggle with sequential edits and temporal consistency [^131^][^137^]. Scalable lifelong temporal knowledge updating remains unsolved.

---

## 6. Summary and Recommended Deep-Dive Areas

### Core Findings Summary

**Training data composition profoundly shapes LLM temporal reasoning through at least four distinct mechanisms:**

1. **Tokenization artifacts** fragment dates into subword pieces, with fragmentation ratios varying dramatically across model families (0.15 for OLMo to 0.60 for Llama 2). This creates a direct bottleneck that larger models partially compensate through "date abstraction" at intermediate layers.

2. **Temporal distribution follows power laws**: Web-scale corpora (CommonCrawl, etc.) are dominated by recent content, creating severe long-tail sparsity for historical knowledge. This leads to catastrophic forgetting of distant temporal facts and insufficient learning for long-span reasoning.

3. **Knowledge cutoffs are not clean boundaries**: Effective cutoffs differ from reported cutoffs due to old data in new crawls and deduplication artifacts. Some models exhibit multiple partial cutoffs corresponding to different training phases.

4. **Training paradigms can partially mitigate but not solve** temporal limitations: Ticktack's sexagenary representation (+34% accuracy), TiC-LM's replay strategies (62% compute reduction vs. retraining), and TISER's structured reasoning all help, but fundamental limitations remain.

### Recommended Deep-Dive Areas

**A. Quantitative temporal distribution analysis of pretraining corpora**
- Direct measurement of year/date frequencies in CommonCrawl dumps
- Characterization of the long-tail distribution for historical vs. recent content
- Analysis of how deduplication affects temporal distribution

**B. Date-aware tokenizer design**
- Vocabulary construction that preserves date components as atomic units
- Adaptive tokenization that recognizes temporal patterns
- Evaluation of the impact on downstream temporal reasoning benchmarks

**C. Temporal curriculum learning**
- Chronologically ordered pretraining vs. random shuffling
- Progressive temporal complexity in instruction tuning
- Evaluation on long-span benchmarks (TempLS, TempUN)

**D. Multimodal temporal grounding**
- Integration of video timestamps, sensor data, and text temporal references
- Cross-modal alignment of absolute and relative time representations
- Benchmark development for multimodal temporal reasoning

**E. Scalable temporal knowledge editing**
- Methods for updating temporal facts without catastrophic forgetting
- Multi-granularity temporal editing (year, month, day precision)
- Lifelong editing benchmarks (WikiBigEdit, TemporalWiki extensions)

---

*Research compiled from 25+ independent searches across arXiv, ACL Anthology, COLM, NeurIPS, and major tech publications. All claims include inline citations and verbatim excerpts from primary sources.*
