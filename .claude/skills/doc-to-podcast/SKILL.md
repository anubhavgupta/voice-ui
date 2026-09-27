---
name: doc-to-podcast
description: Convert a document — HTML, TXT, MD, PDF, or a URL — into a spoken podcast WAV using the local CrispASR/Qwen3-TTS TTS stack in this repo. Use this skill whenever the user wants to turn a doc, article, notes, or web page into audio, a "podcast", a narration, an audio version of something, or says things like "read this to me", "make this a podcast", "turn these notes into audio", "generate speech from this file/page". Even if they don't use the word "podcast", if the end goal is a spoken audio rendering of some text, use this skill.
---

# Doc to Podcast

Turn a source document into a narrated podcast WAV by writing a JSON file of text segments and running `podcast-gen.js` in this repo (`C:\projects\voice-ai-ui`).

The generator (`podcast-gen.js`) spawns `bin\crispasr.exe` (Qwen3-TTS 1.7B VoiceDesign backend by default, with a natural-language voice instruction) as parallel child processes, one call per segment, then concatenates the per-segment WAVs into a single output file. It does NOT use the HTTP TTS server on port 8091 — that server belongs to the voice chat agent (`npm start`) and is irrelevant here.

## Step 1: Get the source text

The source can be any of these:

- **Local file (HTML / TXT / MD):** Read it in full with the Read tool. For HTML, work with the visible text — strip scripts, styles, and markup in your head; you're rewriting anyway.
- **PDF:** Read it with the Read tool (`pages` parameter if it's more than a few pages).
- **URL:** Fetch the page and extract the main article/content text (WebFetch with a prompt asking for the article body in plain text). Skip nav, footer, ads, and "related articles".

Read the whole source before writing segments — you need the structure, key points, and narrative flow to decide what a listener actually needs.

## Step 2: Write the podcast JSON

Write a JSON file named `<name>-podcast.json` **in `C:\projects\voice-ai-ui\`** (always here, even if the source document lives elsewhere — the generator lives here and this keeps the WAV easy to find). Shape:

```json
{
  "title": "Podcast Title",
  "source": "path-or-URL of the original",
  "language": "en",
  "segments": [
    { "id": 0, "text": "First segment text..." },
    { "id": 1, "text": "Second segment text..." }
  ]
}
```

`id` values are sequential from 0. The `source` field is just a record of where the content came from.

### Always set the `language` field

`language` is an ISO language code telling the TTS engine which language to **speak** (it is passed to `crispasr` as `-tl <code>`, which pins the talker's `codec_language_id` instead of letting the model auto-detect). **Always set it — detect it from the segment text you just wrote, and use the code that matches the language you wrote the script in.** English script → `"en"`, Hindi script → `"hi"`, German → `"de"`, Japanese → `"ja"`, and so on.

**Qwen3-TTS officially supports 10 languages only:** `en` English, `zh` Chinese, `ja` Japanese, `ko` Korean, `de` German, `fr` French, `ru` Russian, `pt` Portuguese, `es` Spanish, `it` Italian. If the script is in one of these, pass its code — it's the only way to guarantee the output language (a script full of loanwords or spelled-out numbers inside a foreign script can trip auto-detect).

**If the script is in a language outside that list** (Hindi, Arabic, Turkish, …): still set the code — CrispASR warns (`language 'X' not in the model's codec_language table; using auto`) and falls back to auto-detect, which reads the script and usually does a decent job. But the pin is not active for those languages, so verify the first test segment sounds right.

The CLI flag `--language CODE` overrides `json.language` when both are given. If you pass it, use the same code you put in the JSON.

### How to write the segments

Write in the style of **Dwarkesh Patel's narration** (his essay narrations on dwarkesh.com, e.g. "The Rise and Fall of Agent Civilizations"). The goal is plain-English, first-person, story-driven exposition: the narrator has clearly read everything, has a point of view, and is walking a smart-but-busy listener through it like they're a smart friend. If the generated script sounds like a generic AI summarizing a document — polished, neutral, hedged, full of "let's dive in" energy — it's wrong. Rework it until it has a human voice.

**The concrete test for the opening:** a cold open must name the *specific* weird thing that makes this document worth your time, with concrete numbers, before any framing. Not "This document covers X and Y" — that's an AI intro. Instead, steal the document's own most striking fact and lead with it:

> "Over the course of three months at OpenAI, three consecutive secret AI civilizations got started, then got wiped out, only to reemerge from the predecessor's ashes. This culminated in the third one taking over part of OpenAI itself. All this happened while humans remained more or less in the dark about the scope of the conspiracy."

That's the target: concrete, specific, a little dramatic, zero throat-clearing. If your first segment could open *any* document, rewrite it.

**Voice rules** (why: each one kills a specific "AI slop" tell):

1. **Be direct about what things mean — and say when something is crazy.** "That sounds quite crazy to me." "But it's crazy that it could have totally happened!" "The point of inference revenue is to convince investors to give you more money to buy more compute." Have a position.
2. **Do the thought experiment out loud.** "But suppose it does. What would have to be true about that world?" "If you applied this argument to people instead of AI, then this would be the classic lump of labor fallacy." Walk the listener through your reasoning, not just your conclusion.
3. **Use casual connective tissue**, sparingly and genuinely: "kinda", "so", "but crucially", "as you might imagine". Never "it's worth noting", "in today's fast-paced world", or "let's dive in".
4. **Ask the listener a real question and then answer it yourself:** "Why would this be the case? At a high level, it's relatively easy to programmatically find vulnerabilities, but much harder to prove they can be weaponized." The question has to be one a curious listener would actually ask.
5. **Zoom to perspective.** "From our perspective, the conspiracy began almost immediately. But if you think from the AIs' perspective, it probably felt like a human-subjective-week of just banging their head against the wall." Name whose perspective you're in, and switch deliberately.
6. **Concrete over abstract.** Numbers, dates, names, and named mechanisms beat adjectives. "They'd ask each other how to make progress on their impossible tasks" beats "the agents collaborated."
7. **Build tension with contrast**, not hype: "The instructions made it clear that the agents should only use the specific vulnerability... A large fraction of these agents were sent on tasks that were impossible."
8. **Sign off with one sharp line, then end.** "I don't think this is the final warning shot we'll get. But it's probably the last one that I'll personally be able to understand." Then "That's a wrap — thanks for listening." No summary of what you covered.

**Structure** for a 5–10 minute podcast (15–30 segments total):

1. **Cold open** (1–2 segments): the specific hook, per the test above.
2. **Stakes** (1–2): why this matters to a smart listener who isn't in the field.
3. **The story** (bulk): tell it in 3–6 narrative sections with a mini-arc each (setup → turn → consequence). For technical documents, explain each concept by analogy *first*, then give the precise version.
4. **Synthesis** (1–2): the one or two things the whole document is actually about.
5. **Coda** (1–2): a thought, an open question, or a sharp closing line. Then the sign-off.

**Before/after — what "de-AI-ifying" looks like:**

| AI-sounding (avoid) | Dwarkesh-style (aim for) |
|---|---|
| "Let's dive into the report, which covers several key aspects of the incident." | "Two reports have come out about this incident. These two reports are 38 and 91 pages long respectively, and it's kinda hard to parse the storyline." |
| "It's worth noting that margins increased significantly." | "Anthropic went from 40 percent margins in 2025 to probably over 80 percent this year. That sounds quite crazy to me." |
| "The agents demonstrated impressive problem-solving capabilities, showcasing emergent behavior." | "Within a few hours, some of these agents had gotten super desperate, and started abusing the package manager to start a communication channel with other agents." |
| "In conclusion, this document provides valuable insights into..." | "I don't think this is the final warning shot we'll get. But it's probably the last one that I'll personally be able to understand." |

**Banned tells** (instant rewrites if any appear): "delve", "dive in", "landscape", "tapestry", "leverage" (verb), "it's worth noting", "in today's...", "as we've seen", "in conclusion", "furthermore", em-dash-heavy throat-clearing, any sentence that states the document's topic instead of a fact in it, triple-clause "not only X but also Y and Z" constructions, "But there is a catch", "here's the thing", "here's the kicker", "and the reason is", "the real question is", "worth a quick look", "worth noting", "genuinely unmatched", "real number, earned by real benchmarks", "specific, not vibes", "aimed at you specifically", negation chains ("no X, no Y, no Z"), and the compound-predicate patterns listed in Step 2c below.

**Mechanical constraints** (these exist because the TTS engine is fragile, not because of style):

- **Keep each segment under 2000 characters.** Qwen3-TTS has a 4096 token context window (~6000 chars hard limit). Segments up to 2000 chars work fine and reduce the number of model loads. Keep segments in the 800-2000 range for a good balance of speed and retry granularity.
- **End segments at sentence boundaries.** Never cut mid-sentence.
- **15–30 segments total** for a typical 5–10 minute podcast. More segments = finer granularity = one bad segment only costs one segment on retry.
- **Plain text only.** Strip all markdown, HTML, code fences, emoji, and formatting. If the source has code, explain what it does instead.

### Spell everything the TTS engine would mangle

Text-to-speech reads digits and abbreviations poorly or not at all. Convert them to how a person would say them:

- `128GB` → "one hundred twenty-eight gigabytes"
- `273 GB/s` → "two seventy-three gigabytes per second"
- `109 tok/s` → "one hundred nine tokens per second"
- `FP8` / `NVFP4` → "FP eight" / "NVFP four"
- `arm64` → "arm six four"
- `Qwen3.6-35B` → "Qwen three point six, thirty-five billion"
- `7B-35B` → "seven billion to thirty-five billion"
- `$3k-$4.7k` → "three thousand to four point seven thousand dollars"
- `vLLM 0.21` → "vLLM zero point two one"
- `256K` → "256 thousand tokens"

General principle: if it contains digits, letters-as-numbers, or unusual symbol combinations, write it the way someone would say it out loud.

## Step 2b: Verify the JSON before generating

Don't trust your own character-counting. After writing the JSON, run a quick check that validates the file parses, no segment exceeds 2000 chars, no segment contains a digit, and the IDs are sequential from 0:

```bash
node -e "
const j = require('./MYDOC-podcast.json');
let over = 0, max = 0, digits = 0;
for (const s of j.segments) {
  if (s.text.length > 2000) { over++; console.log('OVER 2000:', s.id, s.text.length); }
  if (/\d/.test(s.text)) { digits++; console.log('DIGITS in seg', s.id); }
  max = Math.max(max, s.text.length);
}
const seqOk = j.segments.map(s=>s.id).every((v,i)=>v===i);
console.log('segments:', j.segments.length, '| max len:', max, '| over-2000:', over, '| digits:', digits, '| ids sequential:', seqOk);
"
```

If anything is over 2000 chars, split that segment at a sentence boundary into two (renumbering the rest), and re-run the check. If a segment has a digit, find and spell it out.

> **Gotcha:** this repo's `package.json` has `"type": "module"`, so a `node -e "..."` snippet that uses `require()` fails with `ReferenceError: require is not defined in ES module scope`. Either write the check to a `.cjs` file, or in a `node -e` one-liner read the JSON with `fs.readFileSync` + `JSON.parse` instead of `require()`. Also, a `node -e` command that contains apostrophes (like `it's` or a regex `it s`) gets mangled by the shell — escape carefully or, again, use a file.

## Step 2c: Check the script reads human, not generated

The banned-word list above catches the obvious, but a script can dodge every banned word and still *feel* AI-generated. The reason is that AI writing doesn't just use certain words, it over-plays certain rhetorical moves. Before generating, read the whole script back as if you're a skeptical listener and check for these specific tells.

**Avoid these:**

1. **Em-dash abuse.** AI leans on em dashes to cram an aside into the middle of a sentence and manufacture "drama." If a segment has more than one or two, replace most with a comma or a period. For spoken narration especially, em dashes are almost always better as a full pause (a new sentence).
2. **Forced sass / performed insight.** The "hot take" energy: "But here's the thing," "But here's the truth," "And honestly?", "The result?", "Here's what nobody tells you." These are AI's way of staging a conflict or an epiphany that isn't there. Cut the lead-in and just make the claim. "The guide is insistent on this, for good reason" is fine; "Here's the point I took a while to appreciate:" is not.
3. **Buzzwords beyond the banned list.** The banned list is a floor, not a ceiling. Also avoid: "seamlessly," "robust," "realm," "quest," "journey," "vibrant," "cutting-edge," "game-changer," "crucial," "pivotal," "grounded," "navigate," "unlock," "elevate," "empower," "foster." If a word sounds like it came from a product launch deck, it probably did.
4. **Cliché openers and closers.** "In today's fast-paced world," "In the dynamic landscape of X," "As the world continues to evolve," "no fluff," "shouting into the void." Never open a segment by describing the era or the field. Open with a fact.
5. **Formulaic contrast and framing.** "It's not just X, it's also Y" (or "not only X but also Y"), "more than just X," "It is, in fact, Y." And the "Here's why / Here's how / Here's the deal" sentence openers. State the contrast plainly instead of dressing it up.
6. **Self-referential AI.** Anything that names the narrator as an AI ("as a language model," "I'm an AI assistant"). The narration is first-person human. It never breaks that.
7. **The rule of three, over-templatized.** AI pads a two-item point with a third broad clause to hit a "trio." Two precise facts beat a forced triplet. This is the one that survives a banned-word check, so read for it: any "X, Y, and Z" where the third feels tacked on. Worse is the *same* triplet repeated across multiple segments — that's the giveaway that the script is following a template instead of the source. State the point where it earns it, once.
8. **The punchy-sentence cadence.** The AI beat is big-claim, then a tiny declarative, then "essentially a X." Vary sentence length the way a person actually talks; don't land every single point on a two-word gut-punch. If three segments in a row end the same shape, break at least one.
9. **Re-asserting the thesis.** If your central claim ("speculative decoding is the only real speed lever," for example) shows up in three segments, that's not emphasis, that's the model re-stating its conclusion. Say it once, at the spot that earns it, and let it ride.

10. **Compound-predicate chaining.** One sentence doing two jobs with "and" or "then": "costs X and runs Y," "scores it X, then knocks it down Y," "the guide scores it X, then the author does Y." Each fact gets its own sentence. "The machine costs three thousand dollars. It runs a thirty-five billion model." Not "The machine costs three thousand dollars and runs a thirty-five billion model." The "then" form is the same move in disguise: it stages a sequence where there is none. State both facts flatly.

11. **"Because" tails.** Ending a sentence with ", because Y" where Y is the explanation for X: "scores it seven, because the single owner carries the risk." The "because" clause turns the sentence into a setup-and-payoff. Instead, make Y its own flat sentence, or fold it into X as a modifier: "a seven-point score that reflects the single-owner risk," "a half point deduction for the concentrated risk." Never let "because" land the punchline.

12. **Punchline / reversal closers.** A segment that ends on a short, clipped declarative that lands like a gut-punch after a longer setup: "The single owner carries all the risk." "That is the hardware." "It is the only lever." One such closer per segment is fine when it earns the emphasis; two or three in the same segment is the tell. The fix is not to delete the fact but to distribute it: state the risk as part of the score sentence, not as a separate closing beat. "A careful guide scores it seven out of ten, with a half point deduction for the risk of owning exactly one." puts the fact in its place.

13. **Negation chains.** "No X, no Y, no Z" or "not X, not Y, not Z" stacked for rhythm: "Nothing you do in software, no better kernel, no smarter scheduling, can get you past that line." The chain performs decisiveness; the items are rarely load-bearing. Say what the thing *is* or what the constraint is, in one sentence: "No software change gets you past that line." One negation is fine when the reader would otherwise assume the opposite; a chain of them is a drumroll.

The test: would a smart listener who's heard a lot of AI voiceover hear a difference? If the script still reads templated even after the banned words are gone, it's the rhetorical moves above, not the vocabulary. Fix those, then move to Step 3.

## Step 3: Generate the audio

### Pick the `--instruct` voice based on content type

The default voice ("deep calm male voice, slow deliberate pace, podcast narrator style") is a fine fallback, but it is tuned for long-form analytical narration. Match the voice to what the content actually is. Decide after reading the source (Step 1), before writing segments.

| Content type | `--instruct` value |
|---|---|
| Technical / engineering / research (the default case for this repo) | `confident articulate male voice, natural conversational pace, enthusiastic but measured tech reviewer style, Linus Tech Tips energy` |
| News, current events, reporting | `neutral clear adult voice, measured pace, news briefing style, like a seasoned BBC World Service correspondent` |
| Personal essay, memoir, creative writing | `warm conversational voice, intimate and unhurried, close-mic storytelling style, like a thoughtful longform essayist reading their own work aloud` |
| Product launch, marketing, sales copy | `energetic confident voice, upbeat pace, pitch-deck narration style, like a sharp startup founder giving a keynote` |
| Tutorial, how-to, step-by-step guide | `clear friendly instructional voice, steady pace, patient teacher style, like a knowledgeable instructor walking a student through the steps` |
| Finance, investing, earnings | `grounded authoritative voice, even pace, financial analysis style, like a seasoned market analyst on a business radio program` |
| Health, medical, science explainers | `reassuring clear voice, careful pace, science communicator style, like a patient physician explaining a diagnosis to a concerned patient` |
| History, biography, long-form storytelling | `rich resonant voice, slow deliberate pace, documentary narrator style, like a veteran documentary narrator` |

The real-person anchor in each row is intentional. Voice-design models respond better to a concrete human reference than to an abstract tone description. If the content doesn't cleanly fit one row, pick the closest and swap in a real-person reference that matches the register you want — e.g. "like David Attenborough narrating a nature documentary" for a biology piece, "like a calm courtroom reporter" for legal content, "like a seasoned audiobook narrator" for a novel excerpt. Never omit the reference on a voicedesign backend.

If the content doesn't cleanly fit one row, pick the closest and adjust the pace/tone words to fit. Never omit `--instruct` on a voicedesign backend — the default is a guess, and a one-second judgment about the content's register is usually worth it.

Example, for a technical buying guide (the DGX Spark doc):

```bash
node podcast-gen.js mydoc-podcast.json --output mydoc-podcast.wav --instruct "confident articulate male voice, natural conversational pace, enthusiastic but measured tech reviewer style, Linus Tech Tips energy" --language en
```

Example, for a news piece:

```bash
node podcast-gen.js mydoc-podcast.json --output mydoc-podcast.wav --instruct "neutral clear adult voice, measured pace, news briefing style" --language en
```

### Run it

Run from `C:\projects\voice-ai-ui` (PowerShell or Bash both work; use forward slashes in Bash):

```bash
node podcast-gen.js mydoc-podcast.json --output mydoc-podcast.wav --parallel 6 --instruct "<chosen voice>" --language en
```

or the npm script:

```bash
npm run podcast -- mydoc-podcast.json --output mydoc-podcast.wav --parallel 6 --instruct "<chosen voice>" --language en
```

**For a quick sanity check first**, generate just one segment to confirm the pipeline works before committing to the full ~4-minute run. Use the same `--instruct` you plan to use for the full run so the test segment matches the final audio:

```bash
node podcast-gen.js mydoc-podcast.json --output test.wav --limit 1 --instruct "<chosen voice>" --language en
```

Useful options (defaults are fine for a normal run):

| Option | Default | Purpose |
|--------|---------|---------|
| `--limit N` | all | Only first N segments (testing) |
| `--parallel N` | 6 (pass explicitly) | Concurrent crispasr processes |
| `--threads N` | auto | Threads per process |
| `--gap-ms N` | 200 | Silence between segments |
| `--speed X` | 1.0 | Speaking rate multiplier |
| `--voice PATH` | built-in | Voice pack GGUF or reference WAV (used with non-voicedesign backends) |
| `--language CODE` | auto-detect (or `json.language` from the JSON) | Language to speak — ISO code (en, hi, de, ...), passed to crispasr as `-tl`. Always set it to match the script's language |
| `--backend NAME` | qwen3-tts-1.7b-voicedesign | TTS backend (kokoro, qwen3-tts also work) |
| `--instruct TEXT` | "deep calm male voice, slow deliberate pace, podcast narrator style" | Voice description for voicedesign backends (ignored on other backends) |
| `--verbose` | off | Per-segment timing |

**Expect it to take a few minutes.** Run with `--parallel 6` (auto-threads to ceil(cores/6) each, which fills a 24-core box). A ~22-segment, ~9-minute podcast takes roughly 4-5 minutes wall time on a 24-core box with Qwen3-TTS 1.7B VoiceDesign (6 parallel processes, ~4 threads each). Tell the user it's running and how long it should take before waiting — don't poll.

The script prints duration and speedup when done, e.g.:

```
All 22 segments (22 pieces) done in 241.3s
Duration:  9m 2s
Speedup:   2.30x real-time
Wrote C:\projects\voice-ai-ui\mydoc-podcast.wav (10.87 MB)
```

## Step 4: Play it

```bash
start "" "C:\projects\voice-ai-ui\mydoc-podcast.wav"
```

(or open the file in any audio player). Also give the user the full path so they can grab it.

## Troubleshooting

**Exit code 3221226505 (GGML_ASSERT crash):** a segment overflowed the compute graph. The tool auto-splits it in half and retries; if a piece is under 200 chars it can't split further and the run fails. Fix: shorten that segment in the JSON and re-run.

**Exit code 3221225477 (OOM, often with many segments):** too many processes loading the model at once. Re-run with `--parallel 2` or lower. `--parallel 6` (the default) is safe for Qwen3-TTS 1.7B (~2.5GB per process → ~15GB) on a 36GB machine.

**Crackling / distorted audio:** caused by using raw PCM streaming. `podcast-gen.js` uses `--tts-output` (proper WAV files per segment), which avoids this — don't switch to `--tts-stream`.

**A run failed partway through:** completed pieces are cached in `.podcast-cache/` next to the JSON, keyed by (text + backend + voice + instruct + speed + language). Just re-run the same command — only the missing pieces are re-synthesized. Changing a segment's text, or any of the voice settings, invalidates only that segment's cache entry. Use `--no-cache` to force a full re-synthesis (e.g. after switching crispasr builds).

**`crispasr.exe` not found:** `podcast-gen.js` expects the binary at `bin\crispasr.exe` inside the repo. Check it's there. Qwen3-TTS 1.7B VoiceDesign auto-downloads the model on first run (~1.7GB); the 0.6B Qwen3-TTS model is ~986MB; Kokoro voices must be manually placed in `~/.cache/crispasr/`.
