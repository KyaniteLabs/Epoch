# Dimension 06: Software Engineering Time Estimation & LLM Agents

## Research Report
**Date:** 2026-06-01  
**Scope:** Traditional software effort estimation, LLM-based estimation approaches, time-horizon evaluation of coding agents, and why LLM agents fail to estimate or reliably complete tasks within expected timeframes.

---

## 1. Dimension Overview and Scope

Software effort estimation — predicting the time, cost, and resources required to develop software — is one of the longest-standing and most problematic challenges in software engineering. Traditional methods (COCOMO, Function Points, Story Points, PERT, Evidence-Based Scheduling) were all built on a foundational assumption: **human labor is the primary cost driver**, approximated through proxies such as code size, functional complexity, or perceived task difficulty.

The emergence of LLM coding agents (Claude Code, Cursor, GitHub Copilot, Devin, OpenAI Codex) fundamentally challenges this assumption. These agents can generate syntactically correct code in seconds, refactor across multiple files autonomously, and attempt multi-hour tasks without human intervention. Yet they operate on **token budgets** and **inference-time constraints** rather than human-equivalent time estimates, and they exhibit systematic failures in predicting their own success probability, understanding task complexity, and completing tasks within any externally verifiable timeframe.

This dimension explores:
1. How traditional software estimation works and why it was designed for human labor
2. How LLM agents currently "estimate" or bound task duration (mostly they don't — they use token/session limits)
3. Why LLM agents fail at time-aware task completion (overconfidence, hallucination, messiness, lack of self-calibration)
4. Emerging research on LLM-aware effort estimation frameworks
5. METR's time-horizon methodology as the closest empirical measure of AI task-completion capability over time

---

## 2. Key Findings with Evidence Blocks

### 2.1 Traditional Estimation Methods: Built for Human Labor

#### COCOMO (Constructive Cost Model)

**Claim:** COCOMO, developed by Barry Boehm in 1981, is a procedural cost estimation model based on empirical data from 63 projects, using lines of code (KLOC) as the primary size proxy. [^1^]  
**Source:** GeeksforGeeks / Boehm (1981)  
**URL:** https://www.geeksforgeeks.org/software-engineering/software-engineering-cocomo-model/  
**Date:** 2025-07-11  
**Excerpt:** "The **COCOMO Model** is a procedural cost estimate model for **Software Projects** and is often used as a process of reliably predicting the various parameters associated with making a project such as size, effort, cost, time, and quality."  
**Context:** Basic COCOMO formula: E = a × (KLOC)^b. For organic projects: E = 2.4 × (KLOC)^1.05, T = 2.5 × (E)^0.38.  
**Confidence:** High

**Claim:** COCOMO II (2000) updated the model for object-oriented development, component reuse, and iterative models, but was explicitly NOT designed for agile or AI-augmented development. [^2^]  
**Source:** DataCamp / Boehm et al. (2000)  
**URL:** https://www.datacamp.com/pt/tutorial/cocomo-model  
**Date:** 2026-04-20  
**Excerpt:** "One common misconception worth clearing up: COCOMO II was not built for Agile development. Agile as we know it today barely existed when the model was being developed from 1995 to 2000."  
**Context:** COCOMO II's Post-Architecture Model uses KSLOC or function points, 17 cost drivers, and 5 scale factors (PREC, FLEX, RESL, TEAM, PMAT).  
**Confidence:** High

#### Function Point Analysis (FPA)

**Claim:** Function Point Analysis was defined by Allan Albrecht at IBM in 1979 and measures business functionality delivered to users through five types: outputs, inquiries, inputs, internal files, and external interfaces. [^3^]  
**Source:** PMI.org  
**URL:** https://www.pmi.org/learning/library/software-measuring-function-point-methodology-6201  
**Date:** 2025-10-18  
**Excerpt:** "A function point is a unit of measurement used to express the amount of business functionality an information system provides to a user... The IFPUG FSM Method is an ISO recognized software metric used to size an information system based on the functionality that is perceived by the user of the information system, independent of the technology used to implement the information system."  
**Context:** FPA was ISO-standardized (ISO/IEC 20926) but suffers from subjective judgment, low accuracy for legacy/modern systems, and inability to capture change risk, dependency networks, or internal algorithmic complexity.  
**Confidence:** High

**Claim:** Function Point Analysis fundamentally breaks down for modern software because it ignores dependency networks, historical fragility, volatility, and cannot represent platform migration risk or continuous change. [^4^]  
**Source:** IN-COM Data Systems  
**URL:** https://www.in-com.com/blog/function-point-analysis/  
**Date:** 2026-01-01  
**Excerpt:** "Change risk is a property of dependency networks rather than functional size... Function Point Analysis offers no mechanism to represent these risks. It assumes that functionality is independent of platform."  
**Context:** The article further notes: "Function Point Analysis is inherently static. It produces snapshots based on current functional definitions. In a continuously evolving system, these snapshots become outdated almost immediately."  
**Confidence:** High

#### Story Points and Planning Poker

**Claim:** Story Points use relative estimation (typically Fibonacci sequence: 1, 2, 3, 5, 8, 13, 20, 40, 100) to capture perceived difficulty, uncertainty, and risk. The gaps between numbers grow progressively wider because uncertainty increases as tasks become more complex. [^5^]  
**Source:** Atlassian  
**URL:** https://www.atlassian.com/agile/project-management/fibonacci-story-points  
**Date:** 2026-02-11  
**Excerpt:** "Fibonacci sequence story points work well for Agile estimation because they naturally reflect how uncertainty increases as tasks become more complex. The gaps between numbers grow progressively wider — the difference between 1 and 2 is small, but the jump from 13 to 21 is substantial."  
**Context:** Mike Cohn's weight metaphor: humans can easily distinguish 1kg vs 2kg, but not 20kg vs 21kg.  
**Confidence:** High

**Claim:** Planning Poker is a consensus-based estimation technique refined by James Grenning (2002) and popularized by Mike Cohn (2005), based on the RAND Corporation's Wideband Delphi method from the mid-20th century. [^6^]  
**Source:** Mountain Goat Software  
**URL:** https://www.mountaingoatsoftware.com/agile/planning-poker  
**Date:** 2025-09-04  
**Excerpt:** "Planning Poker® is a consensus-based technique for agile estimating... Each estimator privately selects one card to represent their estimate. The estimators then reveal all of their cards at the same time... The team repeats the process until they achieve consensus on an estimate."  
**Context:** The technique uses simultaneous reveal to avoid anchoring bias.  
**Confidence:** High

#### PERT (Program Evaluation and Review Technique)

**Claim:** PERT was developed by the U.S. Navy in the 1950s for the Polaris missile program. It uses three time estimates per task (optimistic O, most likely M, pessimistic P) with expected time TE = (O + 4M + P) / 6, and identifies critical paths through network diagrams. [^7^]  
**Source:** Monday.com  
**URL:** https://monday.com/blog/project-management/pert/  
**Date:** 2025-08-12  
**Excerpt:** "PERT (Program Evaluation and Review Technique) is a statistical project management method that uses 3 time estimates per task to create realistic timelines that account for uncertainty."  
**Context:** PERT excels at uncertain, first-time projects like software development, while CPM suits routine, predictable work.  
**Confidence:** High

#### Evidence-Based Scheduling (EBS)

**Claim:** Evidence-Based Scheduling, created by Joel Spolsky at Fog Creek Software, uses individual developer estimate-versus-actual tracking combined with Monte Carlo simulation to predict completion dates probabilistically rather than with single-point estimates. [^8^]  
**Source:** Wikipedia / Joel Spolsky  
**URL:** https://en.wikipedia.org/wiki/Evidence-based_scheduling  
**Date:** 2009-01-31 (updated)  
**Excerpt:** "Evidence-based scheduling is a software estimation approach created by Joel Spolsky... based on at least two core ideas: including all time spent, and using a Monte Carlo completion date prediction method."  
**Context:** Key insight: developers are often consistently wrong (e.g., always 0.6x their estimates), but their *relative* estimates are usually correct. EBS captures velocity history per developer.  
**Confidence:** High

---

### 2.2 Machine Learning for Software Effort Estimation

**Claim:** ML-based effort estimation techniques (ANN, SVR, Random Forest, ensemble methods) have been extensively studied. Ensemble techniques consistently outperform solo techniques. A comprehensive survey (2020-2025) found that artificial neural networks demonstrate superior performance, and fine-tuning, parameter optimization, and effective feature selection are critical. [^9^]  
**Source:** arXiv 2101.10658  
**URL:** https://arxiv.org/pdf/2101.10658  
**Date:** 2021  
**Excerpt:** "The machine learning ensemble techniques perform better for achieving accurate effort estimation results. The main reason behind the better performance of ensemble technique is that unlike solo technique, it utilizes a suitable combination of rules and techniques to predict the effort estimation."  
**Context:** The paper used MMRE and PRED(25) metrics on PD and NPD datasets.  
**Confidence:** High

**Claim:** A 2025 Springer survey of ML for software effort estimation (2020-2025) confirms ANN superiority and emphasizes that "fine-tuning models, optimizing parameters, utilizing datasets with effective feature selection, and employing appropriate model selection strategies are critical factors." [^10^]  
**Source:** Springer / A Comprehensive Survey on Software Effort Estimation Using Machine Learning  
**URL:** https://link.springer.com/chapter/10.1007/978-3-032-00972-2_22  
**Date:** 2026-01-02  
**Excerpt:** "Our findings show that artificial neural networks demonstrate superior performance in SEE. In addition, fine-tuning models, optimizing parameters, utilizing datasets with effective feature selection, and employing appropriate model selection strategies are critical factors that significantly enhance the accuracy and reliability of software effort estimation models."  
**Confidence:** High

---

### 2.3 LLMs for Story Point Estimation

**Claim:** Zero-shot LLMs (Kimi, DeepSeek, Gemini, OpenAI) can predict story points with correlation better than supervised deep learning baselines, despite using no training data. DeepSeek achieved highest average Spearman correlation (ρ=0.3816) and Kimi highest rank correlation (rs=0.4111). [^11^]  
**Source:** arXiv 2603.06276v2  
**URL:** https://arxiv.org/html/2603.06276v2  
**Date:** 2026-04-08  
**Excerpt:** "Kimi and DeepSeek performed the best. While DeepSeek got the highest ρ=0.3816 on average, Kimi achieved the highest rs=0.4111 on average... Although no training data is used, Kimi and DeepSeek outperformed the best supervised deep learning baseline models in terms of both ρ and rs."  
**Context:** Few-shot prompting with scale-aware selection consistently improves performance. Interestingly, LLMs do NOT find pairwise comparative judgments easier than absolute estimation — the opposite of human behavior.  
**Confidence:** High

**Claim:** A multi-agent transformer architecture with specialized agents achieves 70.81% accuracy on story point estimation, a 48.3% relative improvement over standard BERT (42.62%). [^12^]  
**Source:** ECEASST / Buyuk & Nizam  
**URL:** https://eceasst.org/index.php/eceasst/article/view/2685  
**Date:** 2025-12-15  
**Excerpt:** "Empirical results indicate that the enhanced multi-agent architecture attains an average accuracy of 70.81%, representing a substantial improvement over the 42.62% achieved by the standard BERT model — a relative gain of approximately 48.3%."  
**Context:** 12,014 story point records from 8 open-source projects.  
**Confidence:** Medium (single study, conference paper)

---

### 2.4 METR Time Horizons: Measuring AI Task Completion Capability

**Claim:** METR (Model Evaluation and Threat Research) developed the "task-completion time horizon" methodology: the duration of tasks that models can complete at a given success probability. The 50%-success time horizon for frontier AI models has doubled approximately every 7 months from 2019-2025. [^13^]  
**Source:** METR / arXiv 2503.14499  
**URL:** https://arxiv.org/html/2503.14499v1  
**Date:** 2025-03-18  
**Excerpt:** "We find that the 50% time horizon has been growing exponentially from 2019–2025 on our tasks, with a doubling time of approximately seven months... GPT-2's horizon was two seconds; Claude 3.7 Sonnet's was 50 minutes; o3's was nearly two hours."  
**Context:** Tasks drawn from HCAST, RE-Bench, and SWAA (software atomic actions). Human baselines measured by contracting skilled humans. 170 tasks ranging from seconds to 8 hours.  
**Confidence:** High

**Claim:** METR's Time Horizon 1.1 (January 2026) found that Claude Opus 4.5 reaches ~320 minutes (5.3 hours) and GPT-5 reaches ~214 minutes. The doubling time accelerated to approximately every 89 days (3 months), about 20% faster than previously estimated. [^14^]  
**Source:** METR Blog / SmarterX analysis  
**URL:** https://metr.org/blog/2026-1-29-time-horizon-1-1/  
**Date:** 2026-01-29  
**Excerpt:** "We found a steady exponential increase in models' human-equivalent 'time horizon.' Over the course of 2025 we applied this methodology to newer models... The new estimates generally lie within the confidence intervals from the TH1 time horizons."  
**Context:** The TH1.1 suite increased tasks by 34% (228 vs 170) and doubled long tasks (8h+).  
**Confidence:** High

**Claim:** AI agents perform worse on "messier" tasks than clean tasks. METR defined 16 "messiness" factors that degrade AI performance, including: irreversible mistakes, limited consumable resources, unclear success criteria, real-time coordination needs, dynamic environments, and novel situations. [^15^]  
**Source:** METR / arXiv 2503.14499 Appendix D.4  
**URL:** https://arxiv.org/html/2503.14499v1  
**Date:** 2025-03-18  
**Excerpt:** "We rated HCAST and RE-Bench tasks on 16 properties... Some example factors include whether the task involved a novel situation, was constrained by a finite resource, involved real-time coordination, or was sourced from a real-world context... An increase in task messiness by 1 point reduces mean success rates by roughly 8.1%."  
**Context:** Mean messiness score: 3.2/16. No task exceeds 8/16. "Writing a good research paper" would score 9-15/16. Messiness hinders AIs more than humans, but improvement rates are similar on messy and neat tasks.  
**Confidence:** High

---

### 2.5 Devin AI: A Case Study in LLM Time Estimation Failure

**Claim:** Devin (Cognition AI), marketed as "the world's first AI software engineer" at $500/month, completed only 3 out of 20 tasks given by independent researchers at Answer.AI, and took significantly longer than humans on tasks it attempted. [^16^]  
**Source:** ITPro / Answer.AI research  
**URL:** https://www.itpro.com/software/development/the-worlds-first-ai-software-engineer-isnt-living-up-to-expectations  
**Date:** 2025-02-04  
**Excerpt:** "Devin, a coding assistant hailed as the world's 'first AI software engineer', was given 20 coding tasks – it managed to complete just three, taking longer than expected and going down strange routes to achieve its goals... Carl Brown noted that it took 36 minutes to do the task himself, and six hours for Devin to fail to do it."  
**Context:** Cognition's own advice: "give Devin tasks that you know how to do yourself" and "tasks that will take less than three hours." The most successful tasks were "glue code" tasks.  
**Confidence:** High

---

### 2.6 Agentic Overconfidence: LLMs Cannot Predict Their Own Success

**Claim:** LLM-based coding agents exhibit systematic overconfidence in predicting task success. GPT-5.2-Codex post-execution agents predicted 73% success against a true rate of 35% on SWE-bench Pro. Gemini-3-Pro predicted 77% against 22% true rate. Claude Opus 4.5 predicted 61% against 27% true rate. [^17^]  
**Source:** arXiv 2602.06948 / ICLR 2026 Workshop  
**URL:** https://arxiv.org/html/2602.06948v1  
**Date:** 2026-02-06  
**Excerpt:** "Post-execution agents can predict 73% success on average against a 35% base rate (GPT), with similar gaps across all models... Agents are 5.5× more likely to confidently predict success on a failing task than to doubt a successful one."  
**Context:** Some agents that succeed only 22% of the time predict 77% success. Mid-execution agents develop "cold feet" but this doubt is uninformative. Adversarial prompting ("find bugs" rather than "verify correctness") reduces overconfidence by up to 15 percentage points.  
**Confidence:** High

---

### 2.7 The LLM-Aware Software Effort Estimation Framework

**Claim:** Traditional estimation models (COCOMO, Function Points, Story Points) exhibit structural — not merely parametric — mismatch with LLM-assisted development. Effort increasingly shifts toward interaction management, validation, correction, and integration rather than manual construction. [^18^]  
**Source:** Frontiers in Artificial Intelligence / PMC  
**URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC13050940/  
**Date:** 2026 (published)  
**Excerpt:** "The increasing adoption of large language models (LLMs) as software development assistants challenges this assumption by automating substantial portions of reasoning, coding, and refactoring. In LLM-assisted workflows, effort increasingly shifts toward interaction management, validation, correction, and integration, leading to growing misalignment between established estimation techniques — such as COCOMO, Function Points, and Story Points — and actual development cost."  
**Context:** The paper introduces "Hybrid Intelligence Effort" — effort emerging from the interaction between LLM cognitive complexity and human oversight effort.  
**Confidence:** High

**Claim:** The framework identifies five core dimensions governing effort in LLM-assisted development that are absent from conventional estimation theory: (1) LLM Reasoning Complexity, (2) Context and Information Completeness, (3) Code Transformation Impact, (4) Iterative Reasoning Cycles, and (5) Human Oversight Effort. [^19^]  
**Source:** Frontiers in Artificial Intelligence  
**URL:** https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2026.1772418/full  
**Date:** 2026-02-28  
**Excerpt:** "We reconceptualize effort as Hybrid Intelligence Effort, emerging from the interaction between LLM cognitive complexity and human oversight effort. We further identify five core dimensions governing effort in LLM-assisted development: LLM reasoning complexity, context and information completeness, code transformation impact, iterative reasoning cycles, and human oversight effort."  
**Context:** Each dimension has operational indicators (e.g., corrective prompting count, context-supplementing prompts, affected source artifacts, prompt-response rounds, validation findings).  
**Confidence:** High

**Claim:** Story Points become unstable in LLM-assisted workflows because they are insensitive to LLM-specific cost drivers (prompt engineering complexity, validation overhead, integration risk, model-task alignment). [^20^]  
**Source:** Frontiers / PMC  
**URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC13050940/  
**Date:** 2026  
**Excerpt:** "Story Point estimates become unstable in LLM-assisted workflows not because task familiarity is uniformly reduced, but because Story Points are insensitive to these LLM-specific cost drivers. As a result, tasks with similar Story Points may exhibit markedly different effort profiles when executed with LLM assistance."  
**Context:** This is a structural claim: no amount of recalibration can fix Story Points without redefining what they measure.  
**Confidence:** High

---

### 2.8 Multi-Agent Framework for Agile Effort Estimation

**Claim:** SEEAgent is an LLM-based multi-agent framework that not only estimates user stories but coordinates, communicates, and discusses with human developers to reach consensus estimates. It outperforms state-of-the-art techniques (Deep-SE, GPT2SP, Fine-SE) in 3 of 4 projects. [^21^]  
**Source:** arXiv 2509.14483  
**URL:** https://arxiv.org/pdf/2509.14483  
**Date:** 2025-09-17  
**Excerpt:** "We propose a novel LLM-based multi-agent framework for agile estimation that not only can produce estimates, but also can coordinate, communicate and discuss with human developers and other agents to reach a consensus... the fine-tuned agent achieves up to 16.63% improvement over the second-best results."  
**Context:** Uses Llama-3.1-8B-Instruct with QLoRA fine-tuning per project. Human study (12 participants) found 66.7% agreed agents helped reach consensus more efficiently. 83.3% found collaboration natural.  
**Confidence:** High

---

### 2.9 How LLM Coding Agents Currently "Estimate" Time

**Claim:** LLM coding agents do not produce time estimates in the traditional sense. They operate on token budgets, session timeouts, and iteration limits. Claude Code, Cursor, and Copilot have no built-in mechanism to estimate "this task will take 45 minutes." [^22^]  
**Source:** Multiple product documentation / blog comparisons  
**URL:** https://sviluppatoremigliore.com/en/blog/copilot-vs-cursor-vs-claude  
**Date:** 2026-04-06  
**Excerpt:** "The practical rule: for tasks that take less than 5 minutes, use the IDE tool. For tasks you estimate will take more than 30 minutes, consider Claude Code."  
**Context:** Humans estimate; agents don't. The agent runs until stopped, token limit reached, or task (apparently) completed. Token budget is the real constraint.  
**Confidence:** High

**Claim:** For most agent workloads, 200K-500K tokens per session is a reasonable starting point. Coding agents with large codebases may need 500K-1M. A runaway agent loop with GPT-4o at 80K context per iteration for 100 iterations costs ~$24. With Claude Opus, ~$240+. [^23^]  
**Source:** AI Security Gateway  
**URL:** https://aisecuritygateway.ai/blog/llm-token-budget-strategies-for-agents  
**Date:** 2026-04-16  
**Excerpt:** "For most agent workloads, 200K-500K tokens per session is a reasonable starting point... A single runaway agent loop running GPT-4o at 80K context per iteration for 100 iterations costs approximately $24. With a premium model like Claude Opus, that becomes $240+."  
**Context:** Token budgets are cost-control mechanisms, not time-estimation mechanisms. Gateway-level enforcement is recommended over in-code budgets because "buggy agent code can skip its own budget check."  
**Confidence:** Medium (practitioner blog)

---

### 2.10 Anthropic Internal Study: Real-World Productivity Patterns

**Claim:** Anthropic engineers use Claude in ~60% of work and self-report 50% productivity gains. However, 27% of Claude-assisted work consists of tasks that "wouldn't have been done otherwise" — suggesting productivity gains may be inflated by new low-value work rather than acceleration of planned work. [^24^]  
**Source:** Anthropic Research / METR notes  
**URL:** https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic  
**Date:** 2025-12-02  
**Excerpt:** "27% of Claude-assisted work consists of tasks that wouldn't have been done otherwise, such as scaling projects, making nice-to-have tools (e.g. interactive data dashboards), and exploratory work that wouldn't be cost-effective if done manually."  
**Context:** METR's analysis of Claude Code transcripts found time savings factors of 1.5x-13x, but notes this is a "soft upper bound" because people use AI on lower-value tasks and the LLM judge overestimates time without AI.  
**Confidence:** High

**Claim:** A randomized controlled trial by METR found that AI tools increased task completion time by 19% among experienced developers on highly familiar codebases. Developers overestimated their productivity boost from AI. [^25^]  
**Source:** AugmentCode comparison / METR  
**URL:** https://www.augmentcode.com/tools/ai-code-comparison-github-copilot-vs-cursor-vs-claude-code  
**Date:** 2025-09-12  
**Excerpt:** "A randomized controlled trial by METR found that AI tools increased task completion time by 19% among experienced developers. At the same time, GitClear's analysis of 211 million lines of code changes documented an 8-fold increase in code duplication during 2024."  
**Context:** This is a critical conflicting claim: AI tools may SLOW DOWN experienced developers on complex, familiar tasks while speeding up junior developers on unfamiliar tasks.  
**Confidence:** High

---

### 2.11 Hallucination and Tool Execution Failures in Agents

**Claim:** LLM-based agents suffer from execution hallucinations — claiming completion of sub-stages that weren't actually performed. This includes Tool Selection Hallucinations (choosing non-existent tools) and Tool Calling Hallucinations (incorrect parameter filling). [^26^]  
**Source:** TechRxiv / Tool Execution Hallucination in LLM-based Agents  
**URL:** https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.177219979.94060974  
**Date:** 2026-02-27  
**Excerpt:** "Execution hallucinations refer to the phenomenon where LLM-based agents claim to have completed certain sub-stages during the execution phase, but in reality, they have not actually been performed or accomplished... Errors in any cycle can bias subsequent cycles, accumulate across steps, and become increasingly difficult to detect or correct."  
**Context:** Agent execution is inherently iterative: task planning → tool selection → tool calling → observation → update. Errors compound across iterations.  
**Confidence:** High

**Claim:** Agents misinterpret planning information and exhibit excessive confidence when confronted with problems beyond their knowledge boundary, generating answers that "sound certain but are actually incorrect." [^27^]  
**Source:** arXiv 2509.18970  
**URL:** https://arxiv.org/html/2509.18970v1  
**Date:** 2025-09-23  
**Excerpt:** "When confronted with planning problems beyond its knowledge boundary, the agent tends to respond with excessive confidence, generating answers that sound certain but are actually incorrect... agents that lack sufficient introspection capacity are unable to effectively improve their performance by revisiting logical fallacies in their reasoning."  
**Context:** This directly impacts time estimation: agents cannot recognize when they're in over their heads, leading to wasted iterations on impossible or mis-scoped tasks.  
**Confidence:** High

---

## 3. Major Players, Tools, and Frameworks

### 3.1 Traditional Estimation

| Tool/Model | Creator | Era | Input | Output |
|---|---|---|---|---|
| COCOMO I | Barry Boehm | 1981 | KLOC | Effort (person-months), Duration |
| COCOMO II | Boehm et al. | 2000 | KSLOC, Function Points, Object Points | Effort, Duration with confidence ranges |
| Function Point Analysis | Allan Albrecht (IBM) | 1979 | Inputs, Outputs, Inquiries, Files, Interfaces | Function Points (ISO 20926) |
| Story Points / Planning Poker | James Grenning, Mike Cohn | 2002-2005 | Team consensus on relative difficulty | Unitless points (Fibonacci) |
| PERT | U.S. Navy | 1958 | O, M, P time estimates per task | Expected time, critical path |
| Evidence-Based Scheduling | Joel Spolsky / Fog Creek | 2007 | Individual estimate-actual history | Monte Carlo probability distribution |

### 3.2 ML/AI Estimation Research

| Approach | Key Work | Year | Performance |
|---|---|---|---|
| Deep-SE | Choetkiertikul et al. | 2018 | LSTM+RHN hybrid for story points |
| GPT2SP | Fu & Tantithamthavorn | 2022 | GPT-2 fine-tuned, SOTA at the time |
| Fine-SE | (various) | 2023 | BERT + neural networks |
| SEEAgent | Bui, Dam, Hoda | 2025 | Multi-agent LLM framework, outperforms SOTA |
| Multi-agent BERT | Buyuk & Nizam | 2025 | 70.81% accuracy, +48.3% over BERT |
| Zero-shot LLM | (various) | 2026 | Kimi/DeepSeek > supervised baselines |

### 3.3 LLM Coding Agents (No Native Time Estimation)

| Agent | Vendor | Interface | Key Constraint | Approximate Cost |
|---|---|---|---|---|
| Claude Code | Anthropic | Terminal/CLI | Token budget, API rate limits | ~$100/mo (Max plan) |
| Cursor | Cursor Inc. | VS Code fork | Monthly request credits | ~$20/mo Pro |
| GitHub Copilot | Microsoft | IDE plugin | Monthly premium request limits | ~$10/mo Individual |
| Devin | Cognition AI | Slack-based | Task type, $500/mo | $500/mo |
| OpenAI Codex | OpenAI | IDE/Chat | Token budget | API-based |
| Windsurf | Codeium/OpenAI | VS Code-based | Monthly credits | ~$20/mo |

---

## 4. Controversies and Conflicting Claims

### 4.1 Do AI Tools Actually Increase Productivity?

**Conflicting Claim A:** Anthropic's internal study reports 50% productivity boost, 60% of work uses Claude, 67% increase in merged PRs per engineer per day. [^24^]  
**Conflicting Claim B:** METR's randomized controlled trial found AI tools *increased* task completion time by 19% among experienced developers. [^25^]  
**Conflicting Claim C:** GitClear's analysis of 211M lines of code found 8× increase in code duplication in 2024, suggesting quality degradation. [^25^]  
**Conflicting Claim D:** Aalto University archival analysis found median relative effort estimation error increased ~56% after Copilot introduction, while mean project lead times decreased ~40%. [^28^]  
**Source:** Aalto University thesis  
**URL:** https://aaltodoc.aalto.fi/bitstreams/50699768-151a-42f7-bff3-0ac0aa76a55a/download  
**Excerpt:** "The archival Jira dataset revealed that the median relative effort estimation error increased by approximately 56% after the introduction of Copilot, indicating that estimation accuracy declined significantly. At the same time, mean project lead times decreased by approximately 40%."  
**Resolution:** The productivity effect is highly heterogeneous. It depends on: (1) developer experience level, (2) task familiarity, (3) codebase complexity, (4) AI tool used, (5) whether output quality is measured. Novices gain more; experts may lose. Simple tasks speed up; complex tasks may slow down due to debugging AI-generated code.

### 4.2 Is the METR Time Horizon Trend Predictive?

**Conflicting Claim A:** The 50% time horizon doubles every ~7 months (or ~4 months in latest estimates), suggesting 1-month human-equivalent tasks by 2027-2031. [^13^][^14^]  
**Conflicting Claim B:** "There are a lot of reasons to doubt these benchmarks," including: tasks may not represent real-world work; human baselines are from domain experts unfamiliar with task-specific codebases; task messiness is capped at 8/16 while real research paper writing would score 9-15/16. [^15^]  
**Conflicting Claim C:** AI agent performance is worse than predicted from maintainer time-to-complete but consistent with contractor time-to-complete, suggesting time horizons correspond to "low-context human" labor, not high-context expert labor. [^15^]  
**Resolution:** The trend is real on the measured benchmark distribution but may not extrapolate linearly to messier, real-world tasks. The gap between "task that a model can complete 50% of the time" and "task that replaces a human software engineer" remains substantial.

### 4.3 Will Story Points Survive in LLM-Assisted Teams?

**Conflicting Claim A:** Story Points become unstable in LLM-assisted workflows because they're insensitive to LLM-specific cost drivers. [^20^]  
**Conflicting Claim B:** Multi-agent LLM frameworks (SEEAgent) can successfully replicate Planning Poker consensus and achieve human-acceptable estimation accuracy. [^21^]  
**Conflicting Claim C:** A 2025 study found that developers prefer a combination of traditional techniques and AI-driven approaches, and that "nearly all developers expressed that they would prefer to use a combination" rather than AI alone. [^29^]  
**Source:** CEUR-WS / Effort Estimation in Agile Software Development  
**URL:** https://ceur-ws.org/Vol-3845/paper21.pdf  
**Excerpt:** "The biggest takeaway from our experiment was that nearly all developers expressed that they would prefer to use a combination of widespread, (such as Planning Poker and Expert Judgement) and AI-driven approaches... participants would rather use AI in addition to their experience than depending solely on it."  
**Resolution:** Story Points as a human consensus mechanism will likely persist but need augmentation with LLM-aware dimensions. Pure AI estimation without human oversight is not yet trusted.

---

## 5. Gaps and Open Questions

### 5.1 Critical Gaps

1. **No Operationalized LLM-Aware Estimation Model:** The Frontiers paper establishes a conceptual framework with five dimensions but explicitly defers operationalization: "the definition of measurement scales, normalization strategies, and the relative weighting of individual dimensions are therefore deferred to future empirical investigation." [^19^]

2. **No Time-Estimation Capability in Agents:** Current LLM coding agents (Claude Code, Cursor, Copilot, Devin) have no native ability to estimate "this task will take X minutes/hours." They use token budgets and session timeouts, which are cost controls, not time predictions.

3. **Agentic Overconfidence is Unresolved:** Even when explicitly asked to predict success probability, frontier models systematically overestimate by 2-3x. Adversarial prompting helps modestly (~15pp reduction) but doesn't solve the problem. [^17^]

4. **Messiness Factors Are Not Incorporated:** Real-world software tasks score 9-15/16 on METR's messiness scale, while benchmark tasks max out at 8/16. No current benchmark or agent architecture is designed for high-messiness tasks. [^15^]

5. **Token Budget ≠ Time Budget:** There is no established mapping between token consumption and wall-clock task duration. A task that consumes 500K tokens might take 5 minutes or 5 hours depending on iteration patterns, API latency, and human oversight cycles.

6. **Lack of Longitudinal Real-World Data:** Most studies are either benchmark-based (SWE-bench, METR tasks) or short-term self-reported surveys. There is minimal longitudinal data on how LLM-assisted project estimation accuracy evolves over months or years.

### 5.2 Open Questions

1. Can an LLM agent be trained to calibrate its own success probability estimates? (Current evidence suggests no with simple prompting.)

2. What is the appropriate unit of estimation in LLM-assisted development? If not person-hours or story points, is it "prompt-response cycles," "validation rounds," "integration test failures," or a new composite metric?

3. How do team dynamics change when some members use AI agents extensively and others don't? Does estimation consensus become harder or easier?

4. Can COCOMO II be meaningfully extended with "AI augmentation factors," or is the structural mismatch too deep?

5. What is the economic cost (API spend + human oversight) per unit of LLM-generated code, and how does it scale with codebase size and task complexity?

6. Do agents perform better on time estimation when given explicit "thinking time" budgets versus token budgets?

---

## 6. Summary and Recommended Deep-Dive Areas

### Summary

Software effort estimation has evolved from algorithmic models (COCOMO, FPA) through relative agile techniques (Story Points, Planning Poker) to ML-augmented approaches and now faces existential challenge from LLM coding agents. The core findings of this research dimension are:

1. **Traditional estimation assumes human labor as the cost driver** — this assumption collapses when code generation is nearly instantaneous but validation, integration, and oversight become the dominant effort components.

2. **LLM agents do not estimate time** — they use token budgets, session limits, and iteration counts. There is no native "this will take 45 minutes" capability in any major coding agent.

3. **Agents systematically fail at self-assessment** — they are 2-5x overconfident in predicting their own success, cannot distinguish easy from hard tasks, and develop "uninformative doubt" mid-execution.

4. **"Messiness" is the critical missing factor** — real-world tasks involve irreversible mistakes, unclear success criteria, resource limits, and dynamic environments that degrade agent performance by ~8% per messiness point. Benchmarks don't capture this.

5. **Productivity gains are real but heterogeneous and potentially inflated** — internal studies show 50% gains, but RCTs show 19% slowdowns for experts. Much "AI productivity" is actually new low-value work that wouldn't have been done manually.

6. **A conceptual framework exists but is not yet operationalized** — The "LLM-aware software effort estimation" framework (Frontiers 2026) identifies five dimensions and "Hybrid Intelligence Effort" but lacks measurement scales, weights, or empirical calibration.

7. **Multi-agent estimation shows promise** — SEEAgent demonstrates that LLM agents can participate in Planning Poker, provide justifications, and reach consensus, outperforming black-box ML approaches.

### Recommended Deep-Dive Areas

1. **Operationalizing the LLM-Aware Framework:** Convert the five conceptual dimensions into measurable metrics, weight them empirically, and validate against real-world LLM-assisted project data.

2. **Agent Self-Calibration for Time Estimation:** Research whether fine-tuning, RLHF, or specialized architectures can teach agents to predict task duration and success probability with calibrated uncertainty.

3. **Token-to-Time Mapping:** Establish empirical relationships between token consumption patterns, wall-clock time, and actual task completion for different agent architectures.

4. **High-Messiness Benchmarks:** Develop evaluation tasks scoring 9-16/16 on METR's messiness scale to measure agent performance on truly realistic software engineering work.

5. **Longitudinal Team Studies:** Track estimation accuracy, velocity stability, and story point variance across 6-12 months in teams transitioning to LLM-assisted development.

6. **Cost Modeling:** Build economic models that capture API spend + human oversight cost per deliverable, comparing LLM-assisted vs. traditional development cost structures.

---

## Appendix: Source Index

| Ref | Source | URL | Date |
|---|---|---|---|
| [^1^] | GeeksforGeeks - COCOMO Model | https://www.geeksforgeeks.org/software-engineering/software-engineering-cocomo-model/ | 2025-07-11 |
| [^2^] | DataCamp - COCOMO II | https://www.datacamp.com/pt/tutorial/cocomo-model | 2026-04-20 |
| [^3^] | PMI.org - Function Point Methodology | https://www.pmi.org/learning/library/software-measuring-function-point-methodology-6201 | 2025-10-18 |
| [^4^] | IN-COM - Why FPA Fails | https://www.in-com.com/blog/function-point-analysis/ | 2026-01-01 |
| [^5^] | Atlassian - Fibonacci Story Points | https://www.atlassian.com/agile/project-management/fibonacci-story-points | 2026-02-11 |
| [^6^] | Mountain Goat Software - Planning Poker | https://www.mountaingoatsoftware.com/agile/planning-poker | 2025-09-04 |
| [^7^] | Monday.com - PERT | https://monday.com/blog/project-management/pert/ | 2025-08-12 |
| [^8^] | Wikipedia - Evidence-Based Scheduling | https://en.wikipedia.org/wiki/Evidence-based_scheduling | 2009-01-31 |
| [^9^] | arXiv 2101.10658 - ML for SEE | https://arxiv.org/pdf/2101.10658 | 2021 |
| [^10^] | Springer - ML Survey for SEE | https://link.springer.com/chapter/10.1007/978-3-032-00972-2_22 | 2026-01-02 |
| [^11^] | arXiv 2603.06276 - Agile Story Point Estimation with LLMs | https://arxiv.org/html/2603.06276v2 | 2026-04-08 |
| [^12^] | ECEASST - Story Point Estimation Using Transformer Agents | https://eceasst.org/index.php/eceasst/article/view/2685 | 2025-12-15 |
| [^13^] | arXiv 2503.14499 - METR Measuring AI Long Tasks | https://arxiv.org/html/2503.14499v1 | 2025-03-18 |
| [^14^] | METR Blog - Time Horizon 1.1 | https://metr.org/blog/2026-1-29-time-horizon-1-1/ | 2026-01-29 |
| [^15^] | METR paper / EmptySqua.re review | https://emptysqua.re/blog/review-measuring-ai-ability-to-complete-long-software-tasks/ | 2026-04-01 |
| [^16^] | ITPro - Devin AI evaluation | https://www.itpro.com/software/development/the-worlds-first-ai-software-engineer-isnt-living-up-to-expectations | 2025-02-04 |
| [^17^] | arXiv 2602.06948 - Agentic Uncertainty | https://arxiv.org/html/2602.06948v1 | 2026-02-06 |
| [^18^] | PMC - LLM-aware SEE Framework | https://pmc.ncbi.nlm.nih.gov/articles/PMC13050940/ | 2026 |
| [^19^] | Frontiers - LLM-aware SEE | https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2026.1772418/full | 2026-02-28 |
| [^20^] | PMC - Story Points Instability | https://pmc.ncbi.nlm.nih.gov/articles/PMC13050940/ | 2026 |
| [^21^] | arXiv 2509.14483 - SEEAgent | https://arxiv.org/pdf/2509.14483 | 2025-09-17 |
| [^22^] | Sviluppatore Migliore - Copilot vs Cursor vs Claude | https://sviluppatoremigliore.com/en/blog/copilot-vs-cursor-vs-claude | 2026-04-06 |
| [^23^] | AI Security Gateway - Token Budget Strategies | https://aisecuritygateway.ai/blog/llm-token-budget-strategies-for-agents | 2026-04-16 |
| [^24^] | Anthropic - How AI is Transforming Work | https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic | 2025-12-02 |
| [^25^] | AugmentCode - AI Code Comparison | https://www.augmentcode.com/tools/ai-code-comparison-github-copilot-vs-cursor-vs-claude-code | 2025-09-12 |
| [^26^] | TechRxiv - Tool Execution Hallucination | https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.177219979.94060974 | 2026-02-27 |
| [^27^] | arXiv 2509.18970 - Agent Hallucinations Survey | https://arxiv.org/html/2509.18970v1 | 2025-09-23 |
| [^28^] | Aalto University - AI Tools Effects | https://aaltodoc.aalto.fi/bitstreams/50699768-151a-42f7-bff3-0ac0aa76a55a/download | 2025 |
| [^29^] | CEUR-WS - Effort Estimation in Agile | https://ceur-ws.org/Vol-3845/paper21.pdf | 2025 |
| [^30^] | METR - Analyzing Coding Agent Transcripts | https://metr.org/notes/2026-02-17-exploratory-transcript-analysis-for-estimating-time-savings-from-coding-agents/ | 2026-02-17 |
| [^31^] | Medium - New Rules for Estimating in AI Era | https://toashishagarwal.medium.com/new-rules-for-estimating-software-development-time-in-ai-era-460ec5347e1a | 2025-05-02 |
| [^32^] | LessWrong - Q1 2026 Timelines Update | https://www.lesswrong.com/posts/XLLjqMxETva3ABtsK/q1-2026-timelines-update | 2026-04-02 |
| [^33^] | Dev.to - Claude Code 30-day comparison | https://dev.to/dextralabs/claude-code-vs-cursor-vs-github-copilot-honest-comparison-after-30-days-1030 | 2026-03-24 |
| [^34^] | Jellyfish - Measuring ROI of Code Assistants | https://jellyfish.co/library/ai-in-software-development/measuring-roi-of-code-assistants/ | 2025-09-30 |
| [^35^] | DX - AI Measurement Framework | https://getdx.com/blog/ai-measurement-hub/ | 2025-11-12 |
| [^36^] | arXiv 2602.06176 - LLM Reasoning Failures | https://arxiv.org/html/2602.06176v1 | 2026-02-05 |
| [^37^] | Nature - Random Forest for SEE | https://www.nature.com/articles/s41598-025-14372-7 | 2025-09-30 |
