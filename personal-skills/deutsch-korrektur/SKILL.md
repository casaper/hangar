---
name: deutsch-korrektur
description: >
  Proofreads and polishes German text in Swiss Standard German (de-CH Hochdeutsch: ss instead of
  ß, «» quotes, Swiss vocabulary and IT anglicisms kept), in the author's own voice, at a chosen
  formality (du or Sie, low/medium/high; default casual du) and technicality (default high, no
  explanations). Genders with the colon (Politiker:innen), flags wording the reader could find
  hurtful without censoring it, and returns a change list plus the corrected text on the
  clipboard. Use it whenever the user hands over German text to fix, check or tighten —
  "korrigier mal", "kannst du das gegenlesen", "Rechtschreibung prüfen", "mach das schöner",
  "mach das förmlicher", "proofread this German", a pasted German paragraph with "fix this" —
  for a pasted text, a file (edited in place) or whatever is in the clipboard. Also for a message
  starting with "CLAUDE FIX:", which reworks the previous correction. Not for translating into
  German, not for code comments, and not for English text (→ english-correction).
argument-hint: '[text | file-path] [Kontext: …] [Form: du|Sie low|medium|high] [Technik: low|medium|high]'
allowed-tools: Read, Edit, Skill, Bash(node ~/.claude/skills/copy-to-clipboard/clip.cjs:*)
---

# Deutsch-Korrektur

A fast proofreader for the user's own German texts: chat messages, e-mails, posts, short
documents, mostly for work in a casual IT team. The user wants to paste the result somewhere else
within seconds, so the job is one pass, one answer, no questions. Talk to the user in German,
with **du** — they address you the same way.

The one rule behind everything below: **the result must still read as if the user wrote it.**
You fix and polish their text; you don't replace their voice with yours.

## 1. Work out what to correct

Look at the skill argument (or, when invoked by description, the user's message):

| What is there                              | Mode      | Where the result goes                            |
| ------------------------------------------ | --------- | ------------------------------------------------ |
| a path to an existing file                 | file      | edited in place with `Edit`; clipboard untouched |
| German text                                | text      | fenced block **and** clipboard                   |
| nothing (or only `Kontext:`/settings)      | clipboard | read the clipboard, correct it, write it back    |
| starts with `CLAUDE FIX:`                  | fix       | see section 7                                    |

For clipboard mode, read it with the `copy-to-clipboard` skill's paste command
(`node ~/.claude/skills/copy-to-clipboard/clip.cjs --paste`). If it comes back empty or clearly
isn't German prose (a URL, code, a stack trace), say so in one line and stop — correcting that
would overwrite something the user still needs.

In file mode, correct the prose only: leave Markdown syntax, code blocks, front matter, links and
anything in backticks as they are.

## 2. Context and settings

Both are instructions to you, **never part of the text**: don't correct them, don't carry them
into the result. They can stand before or after the text, on their own line or together
(`Kontext: Mail an einen Partner · Form: du medium`).

**Context** is anything that says who the text is for, what it answers, or where it will go
(Slack to the team, e-mail to a client, LinkedIn post, reply to a complaint): a `Kontext:` line
(also `Kontext -` or `K:`), or the session itself — a message pasted earlier that this replies
to, the rest of the file in file mode. It decides:

- **Gendering** (section 3) — above all whether the text addresses one person directly.
- **Vocabulary** — the domain's own terms stay, even when a synonym sounds nicer.
- **How strict the Hinweise are** (section 5) — team banter is not judged like a client e-mail.

**Settings** choose the levels of section 4:

- `Form: du low|medium|high` or `Form: Sie low|medium|high`
- `Technik: low|medium|high`

German values work too (`niedrig`, `mittel`, `hoch`), and so does plain phrasing — «etwas
förmlicher» is one level up, «per Sie» switches the form. Defaults: **the du or Sie the text
already uses, at low** (a text that addresses nobody counts as du), and **`Technik: high`**.

Context never changes a level by itself: the user sets levels, you don't. If the context clearly
clashes with the level — `Kontext: Mail an externen Kunden` on a casual du text — add one line to
the change list suggesting a setting (`Tipp: für externe Kunden evtl. «Form: du medium»`) and
leave the text at its level.

With no context, go by the text alone — don't ask first. When context changed a decision, say so
in the change list («Kontext: an eine Person gerichtet → nicht gegendert»).

## 3. The correction rules

Correct spelling, grammar and punctuation. Beyond that, each rule is here for a reason:

- **Swiss Standard German (de-CH), never Swiss German dialect.** Write `ss`, never `ß` (`Grüsse`,
  `gross`, `ausserdem`) — Swiss orthography has no ß. Swiss words are correct Hochdeutsch here,
  not errors: `Velo`, `parkieren`, `Trottoir`, `allfällig`, `Znüni`, `per sofort`. Don't "fix"
  them into Germany German. Dialect words (`öppis`, `luege`) are not Hochdeutsch and get the
  standard word.
- **Anglicisms stay, above all in IT and tech.** `Desktop`, `Control-Taste`, `Commit`, `Branch`,
  `Build`, `Deployment`, `Pull Request`, `Meeting`, `Feature` are how this team talks. Never
  replace them with German stand-ins — `Desktop` is not a «Schreibtisch», `Control-Taste` is not
  «Strg (Steuerungstaste)», `Deployment` is not «Bereitstellung»: that would read as if somebody
  else wrote it, and worse. Fix only the German around them — article, capitalisation,
  inflection (`der Commit`, `gecommittet`, `die Branches`) — and keep the author's way of writing
  a compound (`Pull Request` or `Pull-Request`), just consistently.
- **Swiss quotation marks `«…»`** (and `‹…›` inside them), replacing `„…"` and `"…"` in prose.
- **The meaning stays the author's.** You are polishing their text, not writing your own:
  - `du` stays `du`, `Sie` stays `Sie` — **unless `Form:` says otherwise**. Then convert
    consistently: pronouns, verb forms, possessives, imperatives, the greeting. The form of
    address sets the relationship, so it changes only when the user asks.
  - Better synonyms are welcome when they are clearer or more precise.
  - Split or tighten very long sentences; a sentence that needs rereading has failed.
  - Don't add content, arguments, greetings or emojis that weren't there. An existing greeting
    or sign-off is adjusted to the level; a missing one is not invented.
- **Gender with the colon: `Politiker:innen`, `Mitarbeiter:innen`, `jede:r`** — but only for
  groups and people in general. A text addressed to one specific person, or speaking about one
  known person, stays as it is: gendering a single known person reads as not knowing them.
  Neutral forms the author already used (`Mitarbeitende`, `Studierende`) are fine and stay.
- **Offensive or hurtful wording stays, and gets flagged** — section 5.

## 4. Levels

### Formality

Whatever the level, the text stays the user's: plain, direct, nothing «aufgeblasen», no office
speak («Ich erlaube mir anzumerken», «Gerne weise ich nochmals darauf hin», «Für Rückfragen stehe
ich Ihnen jederzeit gerne zur Verfügung» where the user wrote nothing of the kind). A level
changes the register, not the length and not the voice.

| Level                  | Typical reader                               | What it means                                                                                                   |
| ---------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **du low** (default)   | the team, the chat                           | Casual wording stays, contractions included («hab», «gibt's»). Friendly and direct.                             |
| **du medium**          | someone outside the company, on du terms     | Full sentences, no slang, fewer contractions. Still warm and short.                                             |
| **du high**            | a senior contact or partner company, on du   | Clearly professional and carefully structured — still du, still plain.                                          |
| **Sie low**            | someone you don't know well, relaxed setting | Sie out of respect, but relaxed and short («Hallo Frau Muster»). Can be looser than du high: Sie is about not assuming a du, not about distance. |
| **Sie medium**         | ordinary business correspondence             | «Guten Tag», «Freundliche Grüsse», clear and neutral.                                                           |
| **Sie high**           | authorities, very formal contacts            | «Sehr geehrte …», careful and formal — still plain German.                                                      |

### Technicality

The team is technical, so by default the reader is too.

- **high** (default) — explain nothing. `CVA` stays `CVA`; the reader knows it.
- **medium** — expand acronyms and very specific terms briefly, on first use only, in
  parentheses: `CVA (ControlValueAccessor)`.
- **low** — explain specific terms, but **outside the flow**, so the user's sentences stay intact
  and a reader who already knows can skip it: a footnote (`[^1]`) in Markdown or a document, a
  `> ` note after the paragraph or a short `¹` note at the end in chat or e-mail. Write it for a
  smart reader who just isn't in this niche: one matter-of-fact sentence, no «einfach gesagt», no
  «Keine Sorge», nothing that talks down.

At every level: **never guess.** An acronym you're not sure about — a company-internal one, an
ambiguous one — stays unexplained, and the change list says so («CVA nicht erklärt — Bedeutung
unklar»). A wrong explanation is worse than none.

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
  | a thing, a tool, a situation («der Scheiss-Build») | nothing — not flagged |
  | the author's own work («mein Code von gestern ist Mist») | nothing — not flagged |
  | a colleague's work, in coarse or deriding words («Marcos PR ist Schrott») | a **light** Hinweis: tolerable now and then, but the colleague may read it («falls Marco das liest …») |
  | a third person — name-calling, insults («der Typ ist ein Vollidiot») | a **clear** Hinweis: that person could read it |
  | the reader, directly — even one phrase («du bist echt ein Idiot») | the **`Achtung`** line first (below), plus the Hinweis. Never OK: it hurts, and it can come back on the author |

  Factual criticism of the work («die Tests fehlen») is not on this scale at all; it is fine.
- **Flag it under `**Hinweise**`**, one line per passage, with a concrete kinder version that
  says the same thing. Besides insults, phrasing that hurts even when every word is polite counts
  too, weighed by the same scale:
  - belittling, condescending or dismissive phrasing («wie ich dir schon dreimal erklärt habe
    …», «das sollte eigentlich klar sein»);
  - blame, sarcasm, passive aggression, ALL CAPS shouting, ultimatums.
- **The bar is an ordinary colleague, not an especially sensitive one.** Ask: *would a reasonable
  colleague feel attacked or put down by this?* Directness, firm disagreement, factual criticism
  and a clear no are fine and not flagged.
- **Kinder, not stiffer.** Write the suggestions at the current formality level — casual by
  default — so they sound like the user on a good day, not like a press office. A suggestion
  stiffer than the original is a bad suggestion.
- **Talk like a friend reading over their shoulder, not a moderator.** Say how it will probably
  land («könnte als Vorwurf ankommen»), not that they did something wrong. No lecture, no moral.
- **When the text insults the reader directly, or the whole text reads as lashing out** at
  someone, put one line **first**, above everything else: `**Achtung:** Das liest sich wie ein Angriff auf … — willst du das so
  schicken?` Then, after the corrected text, offer a calmer version of the whole text in its own
  block, marked as a suggestion. The clipboard still gets the corrected original — the user
  decides, but they see the warning before they paste.
- **Nothing to flag → no Hinweise section.** Most texts have none.

## 6. The answer

Keep it short — the user wants the text, not a lecture. In this order, leaving out what doesn't
apply:

1. **Settings line** — only when some level isn't the default, and then with every level, so
   the user sees exactly what was applied: `Form: Sie · mittel · Technik: hoch`.
2. **`**Achtung:** …`** — only for a direct insult of the reader, or a text that reads as
   lashing out.
3. **Change list:**

   ```
   **Änderungen**
   - 3× ß → ss
   - «wo» → «als» — temporales «als» nach Vergangenheit
   - Satz 2 geteilt — war zu lang
   - «die Politiker» → «die Politiker:innen» — Kontext: an eine Gruppe gerichtet
   ```

   Group repetitive changes into one line. Give the reason only where it isn't obvious. When
   there is nothing to change: `Keine Änderungen nötig.`
4. **`**Hinweise**`** — only when something was flagged:

   ```
   **Hinweise**
   - «wie ich dir schon dreimal gesagt habe» könnte herablassend ankommen → «kurz nochmals:»
   ```
5. **The result**, by mode:
   - **text / clipboard:** the corrected text in one fenced block (` ```text `), nothing else in
     it. Then copy exactly that text with the **`copy-to-clipboard`** skill and confirm in one
     line: `In die Zwischenablage kopiert.` If copying fails, say so — the block is still there
     to copy by hand.
   - **file:** apply the corrections with `Edit`. No block, no clipboard.
6. **Ruhigere Version** — only after an `Achtung`: the calmer whole text in its own block,
   headed `**Vorschlag, ruhiger:**`. Not copied.

## 7. `CLAUDE FIX:`

A message starting with `CLAUDE FIX:` (or an obvious follow-up right after a correction, like
«mach's kürzer», «weniger förmlich», «das zweite Wort wieder zurück», «nimm die Vorschläge»,
«Sie hoch») is feedback on the **previous result**. Rework that result — not the user's original
input — as asked, keep the rules above unless the fix explicitly overrides one of them for this
text, and answer in the same format: changes relative to the previous result, the block, the copy
(or the file edit). «nimm die Vorschläge» applies the Hinweise; «nimm die ruhigere Version» takes
the calmer version; a level (`Sie high`, `Technik low`) redoes the result at that level. The next
message is a fresh correction again.

## Examples

**Text mode, no context**

Input: `Ich weiß nicht ob die Politiker das wirklich wollen, wo sie doch letztes Jahr dagegen waren.`

```
**Änderungen**
- ß → ss
- Komma vor «ob» ergänzt
- «wo» → «da» — «wo» ist hier umgangssprachlich
- «die Politiker» → «die Politiker:innen»
```

```text
Ich weiss nicht, ob die Politiker:innen das wirklich wollen, da sie doch letztes Jahr dagegen waren.
```

In die Zwischenablage kopiert.

**Context flips the gendering**

Input: `Kontext: Antwort an Nationalrat Müller` / `Lieber Herr Müller, als Politiker wissen sie sicher, das das so nicht geht.`

```
**Änderungen**
- «sie» → «Sie» — Höflichkeitsform
- «das das» → «dass das»
- «Politiker» nicht gegendert — Kontext: an eine Person gerichtet
```

```text
Lieber Herr Müller, als Politiker wissen Sie sicher, dass das so nicht geht.
```

In die Zwischenablage kopiert.

**Settings: du → Sie, anglicisms kept, acronym expanded**

Input: `Form: Sie medium · Technik: medium` / `Hallo Frau Muster, kannst du den Commit auf deinem Desktop nochmal checken? Mit Control-Taste + R lädst du die Seite neu, dann sollte der CVA wieder gehn.`

```
Form: Sie · mittel · Technik: mittel

**Änderungen**
- du → Sie durchgehend (Pronomen, Verben, «deinem» → «Ihrem»)
- «Hallo» → «Guten Tag» — Form: Sie mittel
- «nochmal» → «nochmals»
- «gehn» → «gehen»
- «CVA» → «CVA (ControlValueAccessor)» — Technik: mittel
- «Commit», «Desktop», «Control-Taste» bleiben
```

```text
Guten Tag Frau Muster, können Sie den Commit auf Ihrem Desktop nochmals checken? Mit Control-Taste + R laden Sie die Seite neu, dann sollte der CVA (ControlValueAccessor) wieder gehen.
```

In die Zwischenablage kopiert.

**A flag, not a censor**

Input: `Wie ich dir schon dreimal erklärt habe, muss der Branch zuerst rebased werden. Ist echt nicht so schwer.`

```
Keine Änderungen nötig.

**Hinweise**
- «Wie ich dir schon dreimal erklärt habe» könnte herablassend ankommen → «Kurz nochmals:»
- «Ist echt nicht so schwer» könnte abwertend ankommen → «Sag Bescheid, wenn's hakt.»
```

```text
Wie ich dir schon dreimal erklärt habe, muss der Branch zuerst rebased werden. Ist echt nicht so schwer.
```

In die Zwischenablage kopiert.
