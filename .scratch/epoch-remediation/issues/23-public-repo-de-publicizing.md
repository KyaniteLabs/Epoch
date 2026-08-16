# 23 — Public repo de-publicizing (fleet topology, rescue archive, README truth)

**What to build:** The public mirror stops disclosing private infrastructure and carrying dead weight: fleet Tailscale IPs, SSH users, and receiver addresses move out of public docs/scripts (env-templated); the 36MB rescue/ archive leaves the tracked tree (git history purge is a separate, explicit user decision — do NOT rewrite history without approval); README tech-stack versions synced to package.json and accuracy claims cited to in-repo data sources; a grep gate keeps fleet IPs out.

**Blocked by:** 09 (public-face build extends here).

**Status:** ready-for-agent — destructive steps (history rewrite) explicitly gated on user approval

- [ ] No fleet IPs/SSH users/internal endpoints in tracked files (grep gate; scripts templated via env)
- [ ] rescue/ removed from HEAD (history untouched without explicit approval); repo size reduced
- [ ] README tech-stack matches package.json (TS/Zod/vitest majors); "1,498 matched pairs"-style claims cite their data source or are corrected
- [ ] `.omc/` plan file and generated CheckYourself context untracked
