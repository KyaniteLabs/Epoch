# Plan: LLM Time Estimation Research & Technical Documentation

## Objective
Conduct deep, multi-source research into why LLMs consistently fail at temporal reasoning and time estimation (especially in software engineering contexts), and produce both:
1. A thorough research compendium of all findings
2. Complete technical documentation to build a tool (MCP server/skill) that enables accurate LLM time calculations

## Stage 1 — Deep Research (Skill: deep-research-swarm)
**Goal**: Multi-agent parallel investigation across multiple dimensions.

### Research Vectors:
- **Agent A — Academic/Psychological Foundations**: Search arxiv, scholar, academic papers on LLM temporal reasoning, time estimation cognitive biases, "duration prediction" in NLP/AI, relevant ML research.
- **Agent B — Industry/Practitioner Knowledge**: Search blogs, GitHub issues, MCP ecosystem, OpenAI/Anthropic docs, Hacker News, Reddit, StackOverflow, software engineering forums for discussions on why LLMs can't estimate time.
- **Agent C — Technical Architecture & Tooling**: Research MCP servers, skills frameworks, tool-augmented LLMs, external calculator APIs, time-parsing libraries, current solutions (if any).
- **Agent D — Time Computation & Software Engineering**: Research software estimation methodologies (PERT, function points, story points), time calculation algorithms, MCP server building guides, skill creation patterns.

### Outputs per agent:
- Structured findings with sources
- Key terminology and definitions
- Identified gaps and opportunities

## Stage 2 — Synthesis & Technical Documentation (Skill: report-writing)
**Goal**: Synthesize all research into two integrated deliverables.

### Deliverable 1 — Research Compendium:
- What the problem is called (terminology taxonomy)
- Root causes (architectural, training-data, tokenization, cognitive limitations)
- Current state of fixes and ongoing research
- Case studies and evidence
- Benchmarks or evaluation metrics (if any exist)

### Deliverable 2 — Build Documentation:
- Architecture for an MCP server / skill for time estimation
- Technical specification (schemas, endpoints, functions)
- Integration patterns with LLM agents
- Implementation guide with code examples
- Testing methodology
- Deployment instructions

## Stage 3 — Assembly & Formatting (Skill: docx)
**Goal**: Convert final Markdown documents into downloadable .docx

---

## Stage Dependencies
- Stage 1 outputs feed directly into Stage 2
- Stage 2 outputs feed into Stage 3
- Strict stage-gating: no stage begins until previous is validated
