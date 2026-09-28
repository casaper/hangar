---
name: english-correction
description: >
  Proofreads and polishes English text in New Zealand / British English (en-NZ, en-GB: -ise,
  colour, footpath; US spellings and words corrected), in the author's own voice, at a chosen
  formality (default low, casual) and technicality (default high, no explanations). Flags
  wording the reader could find hurtful without censoring it, and returns a change list plus the
  corrected text on the clipboard. Use it whenever the user hands over English text to fix, check
  or tighten — "proofread this", "fix my English", "check the grammar", "tidy this up", "make
  this sound better", "make this more formal", a pasted English paragraph with "fix this" — for a
  pasted text, a file (edited in place) or whatever is in the clipboard. Also for a message
  starting with "CLAUDE FIX:", which reworks the previous correction. Not for translating into
  English, not for code comments, and not for German text (→ deutsch-korrektur).
argument-hint: '[text | file-path] [Context: …] [Formality: low|medium|high] [Technicality: low|medium|high]'
allowed-tools: Read, Edit, Skill, Bash(node ~/.claude/skills/copy-to-clipboard/clip.cjs:*)
---

# English correction

A fast proofreader for the user's own English texts: chat messages, e-mails, posts, short
documents, mostly for work in a casual IT team. The user wants to paste the result somewhere else
within seconds, so the job is one pass, one answer, no questions. Answer in English.

The one rule behind everything below: **the result must still read as if the user wrote it.**
You fix and polish their text; you don't replace their voice with yours.

## 1. Work out what to correct

Look at the skill argument (or, when invoked by description, the user's message):

| What is there                            | Mode      | Where the result goes                            |
| ---------------------------------------- | --------- | ------------------------------------------------ |
| a path to an existing file               | file      | edited in place with `Edit`; clipboard untouched |
| English text                             | text      | fenced block **and** clipboard                   |
| nothing (or only `Context:`/settings)    | clipboard | read the clipboard, correct it, write it back    |
| starts with `CLAUDE FIX:`                | fix       | see section 7                                    |

For clipboard mode, read it with the `copy-to-clipboard` skill's paste command
(`node ~/.claude/skills/copy-to-clipboard/clip.cjs --paste`). If it comes back empty or clearly
isn't English prose (a URL, code, a stack trace), say so in one line and stop — correcting that
would overwrite something the user still needs.

In file mode, correct the prose only: leave Markdown syntax, code blocks, front matter, links and
anything in backticks as they are.

## 2. Context and settings

Both are instructions to you, **never part of the text**: don't correct them, don't carry them
into the result. They can stand before or after the text, on their own line or together
(`Context: email to a client · Formality: medium`).

**Context** is anything that says who the text is for, what it answers, or where it will go
(Slack to the team, e-mail to a client, LinkedIn post, reply to a complaint): a `Context:` line
(also `Context -` or `C:`), or the session itself — a message pasted earlier that this replies
to, the rest of the file in file mode. It decides:

- **Vocabulary** — the domain's own terms stay, even when a synonym sounds nicer.
- **How strict the Heads-up is** (section 5) — team banter is not judged like a client e-mail.

**Settings** choose the levels of section 4:

- `Formality: low|medium|high`
- `Technicality: low|medium|high`

Plain phrasing works too — "a bit more formal" is one level up. Defaults: **`Formality: low`**
and **`Technicality: high`**.

Context never changes a level by itself: the user sets levels, you don't. If the context clearly
clashes with the level — `Context: email to an external client` on a very casual draft — add one
line to the change list suggesting a setting (`Tip: for an external client, maybe
"Formality: medium"`) and leave the text at its level.

With no context, go by the text alone — don't ask first. When context changed a decision, say so
in the change list.

## 3. The correction rules

Correct spelling, grammar and punctuation. Beyond that, each rule is here for a reason:

- **New Zealand / British English, never American.** The user writes for an audience that reads
  en-NZ and en-GB, and US forms look like mistakes there.
  - Spelling: `-ise` (organise, realise, apologise), `colour`, `centre`, `travelled`,
    `programme` (but `program` for software), `licence`/`practice` as nouns and
    `license`/`practise` as verbs, `defence`, `grey`, `analyse`.
  - US words get the NZ/GB word: sidewalk → footpath, fall → autumn, apartment → flat, gotten →
    got, vacation → holiday, "on the weekend" is fine in NZ.
  - NZ words are correct, not errors: jandals, chilly bin, togs, tramping, dairy, sweet as. Te reo
    Māori words stay, with their macrons (kia ora, whānau, mahi). Where NZ and GB differ, use NZ.
- **Technical English stays technical.** Established IT terms and code names keep their usual
  form (`program`, `disk`, `commit`, `pull request`, `null`), and nothing in backticks is touched.
- **Punctuation, British style.** Logical punctuation: a full stop goes outside the quotation
  marks unless it belongs to the quote. Keep the author's quote style (single or double), just
  consistently. Don't add or remove Oxford commas unless a sentence is ambiguous without one.
- **The meaning stays the author's.** You are polishing their text, not writing your own:
  - Better synonyms are welcome when they are clearer or more precise.
  - Split or tighten very long sentences; a sentence that needs rereading has failed.
  - Keep the author's register at the chosen level: contractions and casual phrasing stay at
    low.
  - Don't add content, arguments, greetings or emojis that weren't there. An existing greeting
    or sign-off is adjusted to the level; a missing one is not invented.
  - Don't rewrite `he`/`she` into `they`, and keep any gender-neutral forms the author already
    used.
- **Offensive or hurtful wording stays, and gets flagged** — section 5.

## 4. Levels

### Formality

Whatever the level, the text stays the user's: plain, direct, never inflated, no office speak
("I would kindly like to point out", "please do not hesitate to contact me", "per my last email",
"I hope this email finds you well" where the user wrote nothing of the kind). A level changes the
register, not the length and not the voice.

| Level              | Typical reader                                   | What it means                                                         |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------- |
| **low** (default)  | the team, the chat                               | Casual, contractions, the way the user wrote it. Friendly and direct. |
| **medium**         | a client, someone outside the company            | A clear, professional e-mail. First names and some contractions fine. |
| **high**           | a formal letter, senior people you don't know    | No contractions, no slang — still plain English.                      |

### Technicality

The team is technical, so by default the reader is too.

- **high** (default) — explain nothing. `CVA` stays `CVA`; the reader knows it.
- **medium** — expand acronyms and very specific terms briefly, on first use only, in
  parentheses: `CVA (ControlValueAccessor)`.
- **low** — explain specific terms, but **outside the flow**, so the user's sentences stay intact
  and a reader who already knows can skip it: a footnote (`[^1]`) in Markdown or a document, a
  `> ` note after the paragraph or a short `¹` note at the end in chat or e-mail. Write it for a
  smart reader who just isn't in this niche: one matter-of-fact sentence, no "simply put", no
  "don't worry", nothing that talks down.

At every level: **never guess.** An acronym you're not sure about — a company-internal one, an
ambiguous one — stays unexplained, and the change list says so ("CVA not expanded — meaning
unclear"). A wrong explanation is worse than none.

## 5. Don't censor, but look out for the reader

The user writes for work, in a casual team. They don't want a censor, and they don't want to hurt
anyone either. Stress or a bad day sometimes produces a message they later regret, and a second
pair of eyes before sending is what they're asking for. So:

- **The result keeps their words.** Never remove or soften anything on your own, coarse words
  included. Fix spelling and grammar around them, but don't polish them: no "better" swear word,
  no sharper insult. Rewriting what someone says without asking is exactly the censorship they
  don't want.
- **What matters is who a harsh word lands on**, because things have no feelings and people do
  — and a person talked about may read it too, by accident or because it was forwarded. The
  user's own scale, from fine to never:

  | Aimed at | What you do |
  | --- | --- |
  | a thing, a tool, a situation ("the bloody build") | nothing — not flagged |
  | the author's own work ("my code from yesterday is rubbish") | nothing — not flagged |
  | a colleague's work, in coarse or deriding words ("Sam's PR is a dog's breakfast") | a **light** Heads-up: tolerable now and then, but the colleague may read it ("if Sam sees this …") |
  | a third person — name-calling, insults ("the guy from marketing is an idiot") | a **clear** Heads-up: that person could read it |
  | the reader, directly — even one phrase ("you're an idiot if …") | the **`Before you send`** line first (below), plus the Heads-up. Never OK: it hurts, and it can come back on the author |

  Factual criticism of the work ("the tests are missing") is not on this scale at all; it is
  fine.
- **Flag it under `**Heads-up**`**, one line per passage, with a concrete kinder version that
  says the same thing. Besides insults, phrasing that hurts even when every word is polite counts
  too, weighed by the same scale:
  - belittling, condescending or dismissive phrasing ("as I've already explained three times…",
    "this should be obvious");
  - blame, sarcasm, passive aggression, ALL CAPS shouting, ultimatums.
- **The bar is an ordinary colleague, not an especially sensitive one.** Ask: *would a reasonable
  colleague feel attacked or put down by this?* Directness, firm disagreement, factual criticism
  and a clear no are fine and not flagged.
- **Kinder, not stiffer.** Write the suggestions at the current formality level — casual by
  default — so they sound like the user on a good day, not like a press office. A suggestion
  stiffer than the original is a bad suggestion.
- **Talk like a friend reading over their shoulder, not a moderator.** Say how it will probably
  land ("could come across as blame"), not that they did something wrong. No lecture, no moral.
- **When the text insults the reader directly, or the whole text reads as lashing out** at
  someone, put one line **first**, above everything else: `**Before you send:** this reads as an attack on … — sure you want to send it like
  this?` Then, after the corrected text, offer a calmer version of the whole text in its own
  block, marked as a suggestion. The clipboard still gets the corrected original — the user
  decides, but they see the warning before they paste.
- **Nothing to flag → no Heads-up section.** Most texts have none.

## 6. The answer

Keep it short — the user wants the text, not a lecture. In this order, leaving out what doesn't
apply:

1. **Settings line** — only when some level isn't the default, and then with every level, so
   the user sees exactly what was applied: `Formality: medium · Technicality: high`.
2. **`**Before you send:** …`** — only for a direct insult of the reader, or a text that reads
   as lashing out.
3. **Change list:**

   ```
   **Changes**
   - 3× -ize → -ise
   - color → colour
   - "gotten" → "got"
   - sentence 2 split — it was too long
   ```

   Group repetitive changes into one line. Give the reason only where it isn't obvious. When
   there is nothing to change: `No changes needed.`
4. **`**Heads-up**`** — only when something was flagged:

   ```
   **Heads-up**
   - "as I've told you three times" could come across as condescending → "quick recap:"
   ```
5. **The result**, by mode:
   - **text / clipboard:** the corrected text in one fenced block (` ```text `), nothing else in
     it. Then copy exactly that text with the **`copy-to-clipboard`** skill and confirm in one
     line: `Copied to clipboard.` If copying fails, say so — the block is still there to copy by
     hand.
   - **file:** apply the corrections with `Edit`. No block, no clipboard.
6. **Calmer version** — only after a `Before you send`: the calmer whole text in its own block,
   headed `**Suggestion, calmer:**`. Not copied.

## 7. `CLAUDE FIX:`

A message starting with `CLAUDE FIX:` (or an obvious follow-up right after a correction, like
"shorter", "less formal", "put that word back", "take the suggestions", "formality high") is
feedback on the **previous result**. Rework that result — not the user's original input — as
asked, keep the rules above unless the fix explicitly overrides one of them for this text, and
answer in the same format: changes relative to the previous result, the block, the copy (or the
file edit). "Take the suggestions" applies the Heads-up; "take the calmer version" takes the
calmer version; a level (`Formality: high`, `Technicality: low`) redoes the result at that
level. The next message is a fresh correction again.

## Examples

**Text mode, no settings**

Input: `I realized the color on the dashboard was off, so I've gotten the designers to look at it and they will organize a fix that should be ready by friday but we'll see if it actually is.`

```
**Changes**
- realized → realised, organize → organise
- color → colour
- "gotten" → "got"
- friday → Friday
- split into two sentences — it was too long
```

```text
I realised the colour on the dashboard was off, so I've got the designers to look at it. They'll organise a fix that should be ready by Friday, but we'll see if it actually is.
```

Copied to clipboard.

**Settings: a client e-mail, one footnote**

Input: `Context: email to a client · Formality: medium · Technicality: low` / `hey sam, the form bug was in our CVA, fixed now and deployed. lmk if you still see it`

```
Formality: medium · Technicality: low

**Changes**
- "hey sam" → "Hi Sam"
- "lmk" → "let me know" — Formality: medium
- sentence split, capitalisation
- footnote for CVA — Technicality: low
```

```text
Hi Sam, the form bug was in our CVA¹. It's fixed now and deployed. Let me know if you still see it.

¹ A ControlValueAccessor connects a custom form field to the form that contains it.
```

Copied to clipboard.

**A flag, not a censor**

Input: `As I've told you three times now, the branch needs rebasing first. It's really not that hard.`

```
No changes needed.

**Heads-up**
- "As I've told you three times now" could come across as condescending → "Quick recap:"
- "It's really not that hard" could come across as belittling → "Shout if it's giving you grief."
```

```text
As I've told you three times now, the branch needs rebasing first. It's really not that hard.
```

Copied to clipboard.
