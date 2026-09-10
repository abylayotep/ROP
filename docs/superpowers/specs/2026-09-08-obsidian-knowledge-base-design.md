# The knowledge base as a vault

**Date:** 2026-09-08
**Status:** Approved. Ready for implementation planning.
**Stage:** 8 of the pleep-model rebuild, part 1 of 3. Replaces the store designed in
[the knowledge base](2026-09-03-knowledge-base-design.md). Read with
[agent coaching](2026-09-08-agent-coaching-design.md) and
[drafts and test runs](2026-09-08-drafts-and-test-runs-design.md).

## Goal

Turn the flat list of records into an Obsidian-shaped vault the owner actually wants to
write in: markdown notes in folders, `[[wiki links]]` between them, tags, and a graph. The
agent keeps quoting short exact facts — it retrieves a *section* of a note, not the note —
so long, human notes and precise answers stop being a trade-off.

Obsidian the application is not involved. There is no vault on disk, no sync, no plugin: we
build the editing model inside the cabinet and store it in Postgres like everything else.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the vault lives | In our database, edited in the cabinet | An external vault means a transport (git, zip, a plugin), an account the seller does not have, and a class of "the cabinet is answering from yesterday" bugs. The model we want is Obsidian's; the storage does not have to be. |
| The unit the agent retrieves | A section of a note, split on markdown headings | A note the owner enjoys writing is long. A record the agent quotes must be short. A section is both: the note stays whole for the person, the heading-sized piece goes to the model. |
| The unit the person edits | The whole note, as markdown text | Sections are derived. Nobody edits a chunk, and nothing but the splitter writes one. |
| `[[links]]` and tags | Navigation, backlinks and the graph. Not retrieval | Expanding retrieval along links would hand the agent notes it did not match, and the number guard would then accept prices from a note nobody searched for. Links earn their place by making the vault navigable for the person. |
| Search | The existing Postgres full-text search, moved onto sections | `searchKnowledge` already handles two passes, the hyphen, and the Russian configuration, and the owner's search box must stay the same ranker the agent uses. Only the table under it changes. |
| Imports | Kept: pasted text and a fetched page, now producing notes | A new account's first day should not be an empty editor. The splitter that made items now writes markdown notes. |
| `kb_items` | Migrated into notes and dropped | Two shapes of knowledge would mean two search paths, which is the mistake the 2026-09-03 spec avoided in the first place. |
| Attachments, note history, canvas, themes, plugins | Not in this stage | See "Not in this stage". |

## Data model

Migration `0012`.

```
kb_notes     id, agent_id fk→agents cascade, path text, title text,
             body text, frontmatter jsonb, kind text, tags text[],
             source_id fk→kb_sources set null, edited boolean,
             created_at, updated_at
             unique (agent_id, path)
             index  (agent_id, updated_at)

kb_chunks    id, agent_id fk→agents cascade,
             note_id fk→kb_notes cascade, ordinal integer,
             heading text, title text, content text, kind text,
             search tsvector generated,
             created_at, updated_at
             index (agent_id, kind), gin (search),
             index (note_id, ordinal)

kb_links     id, agent_id fk→agents cascade,
             from_note_id fk→kb_notes cascade,
             to_note_id fk→kb_notes set null, target text,
             index (agent_id, to_note_id), index (from_note_id)
```

`kb_sources` is unchanged. `kb_items` is read by the migration and dropped by it.

**`path`** is the note's identity: `Товары/Двери входные`. Folders are the segments before
the last slash and are not a table — a folder exists because a note is in it, exactly as in
Obsidian. `title` is the last segment, kept as a column so search can weight it without
parsing the path.

**`kind`** carries the five values the record type used to have (`product`, `qa`,
`procedure`, `contact`, `other`), read out of the note's frontmatter and mirrored onto every
chunk. It is what the type filter narrows by, and the search filter narrows inside the
query, never after it.

**`kb_chunks` is derived and disposable.** Every write to a note deletes its chunks and
writes them again in one transaction. No route inserts a chunk, and nothing reads a note's
text out of one.

**`kb_links.to_note_id` is nullable**: a `[[Гарантия]]` written before the note exists is a
broken link, and the vault shows it as one rather than refusing the text. Links are
recomputed for a note on every save, and re-resolved for the whole agent when a note is
created, renamed or deleted — that is what makes a link go live the moment its target
appears.

### Migration of existing records

Each `kb_items` row becomes one note and one chunk:

- `path` — `<Folder>/<title>`, where the folder is the Russian name of the record's kind
  (`Товары`, `Вопросы-ответы`, `Процедуры`, `Контакты`, `Прочее`). A title colliding inside
  its folder gets ` (2)`, ` (3)`; a title containing `/` has it replaced with `∕` so the path
  keeps its meaning.
- `body` — the record's content, unchanged. No heading is invented: a one-section note whose
  section is titled by the note is exactly what a record was.
- `kind`, `edited`, `source_id`, timestamps — copied.

Nothing is lost and nothing is guessed. The migration is one-way; `kb_items` is dropped in
the same migration, after the copy.

## Splitting a note into sections

One function, `splitNote(body)`, in `server/src/lib/knowledge/note.ts`. It is the only thing
that turns text into chunks.

1. **Frontmatter.** A `---` fenced YAML block at the very start is parsed for `kind` and
   `tags` and removed from the body before splitting. An unparseable block is left in the
   body as text rather than swallowed — silently eating the owner's first paragraph is worse
   than showing them dashes.
2. **Headings.** Any markdown ATX heading (`#`…`######`) starts a section. `heading` is the
   heading text; the content is everything up to the next heading of any level. Nesting is
   not modelled: a section is flat, and a `###` under a `##` is its own section, because the
   agent quotes what it is given and a nested tree would hand it the parent's text too.
3. **The lead.** Text before the first heading becomes a section with an empty `heading`.
4. **Long sections.** A section over 8000 characters is cut further by the existing
   `splitLongText` in `server/src/lib/knowledge/split.ts` — paragraph, then line, then space
   — and the parts are numbered in the chunk title, never mid-number.
5. **Empty sections are dropped.** A heading with nothing under it is a table of contents
   entry, not a fact. This is the same rule the page importer already applies.
6. **A fenced code block is opaque.** A `#` inside triple backticks is not a heading. A
   price list pasted as a code block stays one section.

`title`, the string the agent and the screen see, is `Заметка › Раздел`, or just the note
title for the lead section. It is stored rather than composed at read time: it is what the
tsvector weights, and a composed value could not be indexed.

## Search

`searchKnowledge` keeps its signature and its two passes. Three changes:

- it reads `kb_chunks` instead of `kb_items`;
- the tsvector weights the chunk `title` (which carries the note title) as `A` and `content`
  as `B`, the same shape as before;
- a `noteId` is returned alongside each hit so a screen can open the note a section belongs
  to.

`KNOWLEDGE_LIMIT` stays 6, the cabinet's `SEARCH_LIMIT` stays 20, `LIST_LIMIT` stays 100.
Six sections are less text than six old records, so the prompt gets smaller, not bigger.

`ai_replies.used_item_ids` starts holding chunk ids. The column keeps its name — renaming it
would touch the statistics reader for no behavioural gain — and its comment says what it
holds now. The screen that names the records an answer was built from names sections, which
is more useful than it was: «Доставка › По городу» says where in the note to look.

## API

`/api/agents/:agentId/knowledge/…`, replacing the item routes:

| Route | Who | What |
|---|---|---|
| `GET  /notes` | any member | Tree and list. `q` searches (sections, returning their notes), `kind` filters, no `q` lists the newest. |
| `GET  /notes/:noteId` | any member | Body, frontmatter, sections, backlinks, outgoing links, source. |
| `POST /notes` | any member | `path`, `body`. Splits, links, chunks in one transaction. |
| `PATCH /notes/:noteId` | any member | `path` and/or `body`. A rename re-resolves links pointing at the old title. Sets `edited`. |
| `DELETE /notes/:noteId` | any member | Its chunks go with it; links pointing at it become broken, not deleted. |
| `GET  /graph` | any member | Notes and links, for the graph tab. Capped at 500 notes. |
| `GET  /search` | any member | The agent's ranker, unchanged, returning sections. |
| `POST /sources/text`, `POST /sources/page`, `POST /sources/:id/refresh`, `DELETE /sources/:id` | owner | As they are, writing notes. |

Who may do what does not change: any member writes notes, only the owner imports.

## Imports

The two importers keep their rules and change what they write.

**Pasted text.** A blank line still starts a new block, the first line is still the title.
Each block becomes a note at `Вставки/<title>` whose body is the block's remaining lines. A
block over 8000 characters no longer needs numbering at import time — the note holds it and
the splitter numbers the sections.

**A fetched page.** The fetcher is untouched: same allowlist, same 2 MB and 15 s limits,
same one-source-per-address rule. What changes is the writing. A page becomes **one note**
at `С сайта/<page title>`, with the page's `h1`…`h6` kept as markdown headings — so the
sections the agent retrieves are the page's own sections, and the owner reads the page as a
page instead of as forty disconnected records.

**Refresh** keeps its promise at note granularity: a note the source produced and nobody
touched is replaced whole; a note with `edited` is left alone and counted in `keptEdited`,
which the screen still names in words. The page is fetched before anything is deleted.

**Deleting a source** unlinks its notes rather than deleting them, as today.

## Screens

`KnowledgeScreen.tsx` becomes three panes and gains a tab.

- **Left:** the search box and the tree. Folders collapse; a note is one row. The type
  filter stays, above the tree.
- **Centre:** the note. Edit is a markdown textarea; view renders markdown, resolves
  `[[links]]` to clicks and shows a broken one in the muted-error colour. Typing `[[` offers
  note titles. Saving is explicit — nothing autosaves into a store the agent answers from.
- **Right:** backlinks, outgoing links, tags, the source, and «Что найдёт агент» — the same
  search box, run against this agent, showing sections in rank order. It is the honest test
  it was before and it now points at the section, not the note.
- **Graph tab:** notes as nodes, links as edges, force layout on canvas, click opens the
  note. Read-only: no dragging an edge into existence, because a link is text in a note.

Markdown rendering is written here rather than pulled in: what we support is headings,
bold/italic, lists, links, code and blockquotes, and a dependency that supports HTML
embedding would put page-authored HTML into the cabinet.

## Tests

Server:

- `splitNote`: headings at every level, a lead section, an empty heading dropped, a fenced
  block with a `#` inside, frontmatter parsed and removed, unparseable frontmatter kept, a
  section over 8000 numbered on a paragraph boundary.
- Link parsing: `[[Заметка]]`, `[[Заметка|подпись]]`, a broken link, a link resolved when its
  target is created, a link re-pointed when a note is renamed, a link left broken when the
  target is deleted.
- Chunks are rebuilt, not appended: saving a note twice leaves one set.
- Search over sections: strict then loose, `kind` inside the query, the hyphen rules, the
  limit, and a Russian word form found across sections.
- Path uniqueness per agent, and a rename onto an occupied path refused in the operator's
  language.
- Tenancy: every route reaches notes only through `agentId`.
- The migration: five kinds land in five folders, a duplicate title gets a suffix, `edited`
  and `source_id` survive, a record becomes exactly one chunk.

Frontend: the tree renders folders from paths; the editor's link autocomplete; the graph
renders nodes and edges from the API's shape.

## Not in this stage

- **Attachments and images in notes.** The agent cannot send an image, so a vault that
  stores one has nowhere to send it.
- **Note version history.** `edited` is the only flag; the draft mechanism in
  [drafts and test runs](2026-09-08-drafts-and-test-runs-design.md) is what protects a change
  before it lands, and a full history is a different feature.
- **Retrieval along links.** Decided against above.
- **Canvas, themes, plugins, an external vault.** Not the point of any of this.
- **Embeddings.** Still waiting on a provider, still behind the one search signature.
