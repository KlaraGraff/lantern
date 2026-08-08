# Raw evidence — `book_person_aliases` table dump
This is a raw evidence dump for empirical review. No verdicts, scores, or opinions about correctness are included below — only facts pulled from the real production database and the book's own text. All quoted sentences are verbatim from `book_chunks.text` (case as stored; substring searches are case-insensitive, quoted example sentences preserve original case/punctuation).

## Reproducible commands
```bash

# Database (read-only source):

# ~/Library/Application Support/com.klaragraff.lantern/lantern.db

SRC="$HOME/Library/Application Support/com.klaragraff.lantern"
DST="/private/tmp/claude-501/-Users-lijianwei-vibecoding-Lantern/b8f809b9-1dd3-4524-ac33-1fb2f65183cc/scratchpad"

# Copy db + its WAL/SHM so all committed-but-not-yet-checkpointed data is included

# in the copy (the live db file's WAL was newer than the db file at copy time).

# The copy, not the live file, is what gets opened/checkpointed by sqlite3 below.
cp "$SRC/lantern.db"     "$DST/lantern-ro-copy.db"
cp "$SRC/lantern.db-wal" "$DST/lantern-ro-copy.db-wal"
cp "$SRC/lantern.db-shm" "$DST/lantern-ro-copy.db-shm"

DB="$DST/lantern-ro-copy.db"

# Schema
sqlite3 "$DB" ".schema book_person_aliases"
sqlite3 "$DB" ".schema book_person_alias_embeddings"
sqlite3 "$DB" ".schema book_chunks"
sqlite3 "$DB" ".schema books"
sqlite3 "$DB" "PRAGMA foreign_key_list(book_person_aliases);"
sqlite3 "$DB" "PRAGMA foreign_key_list(book_person_alias_embeddings);"

# Row counts / book identification
sqlite3 "$DB" "SELECT COUNT(*) FROM book_person_aliases;"
sqlite3 "$DB" "SELECT book_id, COUNT(*) FROM book_person_aliases GROUP BY book_id;"
sqlite3 -json "$DB" "SELECT a.book_id, b.title, b.author, b.language, b.original_title, b.original_author \
  FROM book_person_aliases a JOIN books b ON b.id=a.book_id GROUP BY a.book_id;"

# Full row dump (all columns), ordered by created_at, alias
sqlite3 -json "$DB" "SELECT * FROM book_person_aliases \
  WHERE book_id='cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e' ORDER BY created_at, alias;"

# book_chunks row count for the book
sqlite3 "$DB" "SELECT COUNT(*) FROM book_chunks WHERE book_id='cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e';"

# Related table: book_person_alias_embeddings — full contents (any book), and for this book
sqlite3 "$DB" "SELECT COUNT(*) FROM book_person_alias_embeddings;"
sqlite3 -json "$DB" "SELECT alias_id, book_id, dimensions, model, created_at, length(embedding) \
  as embedding_bytes FROM book_person_alias_embeddings;"
```

For each of the 25 alias rows, occurrence counting and verbatim-sentence extraction over `book_chunks.text` (ordered by `chunk_index`) for that `book_id` was done with a small Python script (`sqlite3` stdlib module, opened `file:<copy>?mode=ro` URI, read-only) rather than shell LIKE queries, so that sentence boundaries could be located precisely for the verbatim quotes. The counting logic: `re.finditer(re.escape(surface), text, re.IGNORECASE)` per chunk, summed across all 198 chunks of the book — i.e. **plain case-insensitive substring counting**, not word-boundary or whole-name matching. Sentence splitting used a period/question-mark/exclamation-mark boundary detector with a short abbreviation exception list (`Dr`, `Mr`, `Mrs`, single initials like `E.`, etc.) so that names containing a title or a middle initial are not artificially cut in half in the quoted examples.

## Book identification
All 25 rows in `book_person_aliases` belong to a single book:

- `book_id`: `cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e`
- `title`: **Embracing Hope**
- `author` (as stored in `books.author`): Viktor E. Frankl
- `format`: epub, `status`: reading
- `language` / `original_title` / `original_author`: all `NULL`
- Book description (from `books.description`, stored HTML, verbatim): "A highly anticipated, rediscovered collection from Viktor Frankl, published for the first time in the United States, exploring freedom, responsibility, and how we can draw meaning from the temporary nature of our lives... Published here for the first time in the United States, Embracing Hope continues Frankl’s enduring life’s work and provides even more lessons for those searching for meaning and purpose. It’s made up of four distinct pieces from Frankl on different themes..."
- `book_chunks` row count for this book: 198 (chunk_index 0–197)

## Schema: `book_person_aliases`
```sql
CREATE TABLE book_person_aliases (
  id           TEXT PRIMARY KEY,
  book_id      TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  canonical    TEXT NOT NULL,   -- the book's own spelling, e.g. "Mr. Collins"
  alias        TEXT NOT NULL,   -- another way to refer to them, e.g. "柯林斯"
  source       TEXT NOT NULL,   -- 'auto' | 'user'
  mentions     INTEGER NOT NULL DEFAULT 0,  -- chunks where canonical appears verbatim
  created_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'name',  -- 'name' | 'description'
  source_query TEXT  -- for 'description' rows: the query the user was asking when they taught it
);
CREATE UNIQUE INDEX idx_book_person_aliases_unique
  ON book_person_aliases(book_id, alias, canonical);
CREATE INDEX idx_book_person_aliases_book ON book_person_aliases(book_id, alias);
```

Foreign keys (`PRAGMA foreign_key_list(book_person_aliases)`):
```
0|0|books|book_id|id|NO ACTION|CASCADE|NONE
```

There is no separate `book_people` / `book_persons` entity table. `canonical` is a free-text column, not a foreign key to any person/entity table — `book_person_aliases` references `books(id)` directly and nothing else.

## Full JSON dump — all 25 rows of `book_person_aliases`
```json
[
  {
    "id": "3fd8e410-0f2f-401d-ba33-0662156e8aec",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Alexander Vesely-Frankl",
    "alias": "Alexander",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "56151012-4a75-43b1-8319-235ea4702f37",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Alexander Vesely-Frankl",
    "alias": "Alexander Vesely",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "bc0d543a-982e-4d11-b9fc-e7683dfcbd67",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Tobias Esch",
    "alias": "Dr. Esch",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "372aba9f-1d2c-45a7-92ba-497310b71e35",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Dr. Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "689a7397-4c05-4283-92e5-289d53ea2d8b",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Freud",
    "alias": "Dr. Freud",
    "source": "auto",
    "mentions": 12,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "c84f76d1-1ca1-43cd-b657-4c6e7ec066d5",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Tobias Esch",
    "alias": "Dr. Tobias Esch",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "a31e4c52-391d-439b-a42e-112f46bf3cf0",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Dr. Viktor E. Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "727efe3a-0cfd-4501-b75c-bf58e884bc37",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Tobias Esch",
    "alias": "Esch",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "2e8e8709-28eb-4434-9fda-288cb6a3b7cc",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "2cb89754-2be3-4c12-8bdb-dda2312119d3",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Young",
    "alias": "Joel",
    "source": "auto",
    "mentions": 21,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "37af541a-93e2-43bf-b992-6cf3760533bd",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Young",
    "alias": "Joel Young",
    "source": "auto",
    "mentions": 21,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "636d3520-7500-4221-aabd-7c4397dd3f35",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Wassily Kandinsky",
    "alias": "Kandinsky",
    "source": "auto",
    "mentions": 1,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "6ca5a223-ad35-42ed-a3d5-f5455ee5379f",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Professor Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "23a9a939-e893-4776-903f-98c51e98d267",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Professor Viktor E. Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "cd05c113-806d-4f89-86ab-1a482d945100",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Freud",
    "alias": "Sigmund Freud",
    "source": "auto",
    "mentions": 12,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "3b4aed1e-e521-4171-9b2a-387b2fb5ff2d",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Tobias Esch",
    "alias": "Tobias",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "67140153-0970-4d66-8ae5-7c49b0009126",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Wassily Kandinsky",
    "alias": "Vasily Kandinsky",
    "source": "auto",
    "mentions": 1,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "0669a314-ff59-45a2-ba58-170054bf1bfd",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Alexander Vesely-Frankl",
    "alias": "Vesely",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "a2e9be78-6f30-4006-925e-bc4ec76a4061",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Alexander Vesely-Frankl",
    "alias": "Vesely-Frankl",
    "source": "auto",
    "mentions": 3,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "8555988b-2354-452b-add2-7406bf8d250a",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Victor Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "65ecb2d5-720f-441b-a46d-f9b8089f848e",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Viktor",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "f933c97e-65c3-4f62-957a-9d3dc0ff238c",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Viktor E.",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "b9a675bd-c423-458d-aa04-3bf8201a7129",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Viktor Emil Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "038b592f-5533-42d1-bfdd-96a00caf46d0",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Viktor E. Frankl",
    "alias": "Viktor Frankl",
    "source": "auto",
    "mentions": 14,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  },
  {
    "id": "ebeb190e-846d-4f37-a833-d87ffc41a7af",
    "book_id": "cb8d61b1-e5e2-4fdd-9024-6ccd08ae4e6e",
    "canonical": "Wassily Kandinsky",
    "alias": "WASSILY KANDINSKY",
    "source": "auto",
    "mentions": 1,
    "created_at": 1786202674083,
    "kind": "name",
    "source_query": null
  }
]
```

## Related table: `book_person_alias_embeddings`
```sql
CREATE TABLE book_person_alias_embeddings (
  alias_id   TEXT PRIMARY KEY REFERENCES book_person_aliases(id) ON DELETE CASCADE,
  book_id    TEXT NOT NULL,
  embedding  BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  model      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_book_person_alias_embeddings_book
  ON book_person_alias_embeddings(book_id);
```

Foreign keys (`PRAGMA foreign_key_list(book_person_alias_embeddings)`):
```
0|0|book_person_aliases|alias_id|id|NO ACTION|CASCADE|NONE
```

Row count, whole table, all books: `SELECT COUNT(*) FROM book_person_alias_embeddings;` → **0**. The table exists and is wired via foreign key to `book_person_aliases.id`, but contains zero rows for this book (and zero rows total, across every book in the database).

## Per-alias occurrence data
For each row: the stored columns, then the alias surface-form search results, then the canonical surface-form search results. `total_count` = number of case-insensitive substring matches of that exact surface form across all 198 chunks of `book_chunks` for this book (not word-boundary matching — e.g. a search for "Esch" also matches inside a hypothetical longer word containing "Esch"). `stored mentions` is the value already sitting in the `mentions` column of that row (per the schema comment: "chunks where canonical appears verbatim").

### `Alexander` → `Alexander Vesely-Frankl`
- row id: `3fd8e410-0f2f-401d-ba33-0662156e8aec`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Alexander"`** — substring match count: **5**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Foreword copyright © 2023 Alexander Vesely-Frankl"

**Canonical surface form `"Alexander Vesely-Frankl"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Foreword copyright © 2023 Alexander Vesely-Frankl"

### `Alexander Vesely` → `Alexander Vesely-Frankl`
- row id: `56151012-4a75-43b1-8319-235ea4702f37`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Alexander Vesely"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Foreword copyright © 2023 Alexander Vesely-Frankl"

**Canonical surface form `"Alexander Vesely-Frankl"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Foreword copyright © 2023 Alexander Vesely-Frankl"

### `Dr. Esch` → `Tobias Esch`
- row id: `bc0d543a-982e-4d11-b9fc-e7683dfcbd67`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Dr. Esch"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Tobias Esch"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Introduction copyright © 2023 Tobias Esch"

### `Dr. Frankl` → `Viktor E. Frankl`
- row id: `372aba9f-1d2c-45a7-92ba-497310b71e35`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Dr. Frankl"`** — substring match count: **6**
Example sentences (verbatim):
- (chunk_id `625d3f7f-dd35-4699-a510-334c8858b2ab`, chunk_index 5): "After the presentation, the host approached him with a curious observation: “Dr. Frankl, did you notice that the people seemed a little distant, even cold?” To this, my grandfather replied in the affirmative."
- (chunk_id `c5399121-8203-4411-96c0-da0ccf0bafad`, chunk_index 78): "ROY BONISTEEL : Dr. Frankl, you spent three years in four concentration camps during the war."
- (chunk_id `7ebee7e4-6630-4202-8bc9-93abf873d43a`, chunk_index 92): "The American Journal of Psychiatry once wrote up a review on a book of mine; and there, you will find this sentence: “Dr. Frankl’s message is the belief, the unconditional faith, in the unconditional meaningfulness of life.” Right, but it’s more than faith."

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Dr. Freud` → `Freud`
- row id: `689a7397-4c05-4283-92e5-289d53ea2d8b`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **12**
**Alias surface form `"Dr. Freud"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Freud"`** — substring match count: **14**
Example sentences (verbatim):
- (chunk_id `f3370748-dda9-4c23-8885-6843b8f63db0`, chunk_index 31): "And that’s not just in the sense of the two big goals in life that Freud defined in psychoanalysis, his own theory and therapy, which are the ability to work and the capacity for pleasure; but we must also get to grips with the human being’s capacity for suffering."
- (chunk_id `9609ce0d-34ab-4b34-b3de-339437f59026`, chunk_index 86): "First of all, what I have described already 30 years ago, and predicted and foreseen, I might say: the emergence—and today the presence—of what I call the existential vacuum ; the feeling of meaninglessness; the feeling of emptiness; a sense of futility which now takes the place of inferiority feelings; the existential frustration which now takes the place of sexual frustrations, in contrast to the times of Sigmund Freud."
- (chunk_id `db40143b-9a2d-4f28-8f6e-6003034b9a64`, chunk_index 103): "FRANKL : You see, many years ago, I once was lecturing at one of the American universities, and a Freudian stood up in the question-and-answer period and told me, “Dr. Frankl, I just returned from Moscow."

### `Dr. Tobias Esch` → `Tobias Esch`
- row id: `c84f76d1-1ca1-43cd-b657-4c6e7ec066d5`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Dr. Tobias Esch"`** — substring match count: **2**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"

**Canonical surface form `"Tobias Esch"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Introduction copyright © 2023 Tobias Esch"

### `Dr. Viktor E. Frankl` → `Viktor E. Frankl`
- row id: `a31e4c52-391d-439b-a42e-112f46bf3cf0`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Dr. Viktor E. Frankl"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Esch` → `Tobias Esch`
- row id: `727efe3a-0cfd-4501-b75c-bf58e884bc37`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Esch"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Introduction copyright © 2023 Tobias Esch"

**Canonical surface form `"Tobias Esch"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Introduction copyright © 2023 Tobias Esch"

### `Frankl` → `Viktor E. Frankl`
- row id: `2e8e8709-28eb-4434-9fda-288cb6a3b7cc`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Frankl"`** — substring match count: **142**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Man Alive—Viktor Frankl"

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Joel` → `Young`
- row id: `2cb89754-2be3-4c12-8bdb-dda2312119d3`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **21**
**Alias surface form `"Joel"`** — substring match count: **2**
Example sentences (verbatim):
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Translation © Joelle Young 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Joelle Young has asserted her right to be identified as the translator of this work in accordance with the Copyright, Designs and Patents Act 1988."

**Canonical surface form `"Young"`** — substring match count: **29**
Example sentences (verbatim):
- (chunk_id `d0d5aed3-f34c-4ec2-8d02-552f372b3e9f`, chunk_index 41): "At that time, by hook or by crook, I managed to get these young people into youth organizations, public libraries and adult education colleges as “attendants,” as we called them back then."
- (chunk_id `0dde0366-b60d-4174-9592-600db3df09a9`, chunk_index 44): "I have never seen anything like this with much younger colleagues."
- (chunk_id `a640c672-908e-4e2f-b927-283e25683125`, chunk_index 45): "He could compensate for those defects and, with the rest of his capabilities, was able to achieve far more than the average young psychiatrist or neurologist in Vienna at that time."

### `Joel Young` → `Young`
- row id: `37af541a-93e2-43bf-b992-6cf3760533bd`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **21**
**Alias surface form `"Joel Young"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Young"`** — substring match count: **29**
Example sentences (verbatim):
- (chunk_id `d0d5aed3-f34c-4ec2-8d02-552f372b3e9f`, chunk_index 41): "At that time, by hook or by crook, I managed to get these young people into youth organizations, public libraries and adult education colleges as “attendants,” as we called them back then."
- (chunk_id `0dde0366-b60d-4174-9592-600db3df09a9`, chunk_index 44): "I have never seen anything like this with much younger colleagues."
- (chunk_id `a640c672-908e-4e2f-b927-283e25683125`, chunk_index 45): "He could compensate for those defects and, with the rest of his capabilities, was able to achieve far more than the average young psychiatrist or neurologist in Vienna at that time."

### `Kandinsky` → `Wassily Kandinsky`
- row id: `636d3520-7500-4221-aabd-7c4397dd3f35`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **1**
**Alias surface form `"Kandinsky"`** — substring match count: **1**
Example sentences (verbatim):
- (chunk_id `fc288901-07c2-45bf-9e6e-a7656bce29f6`, chunk_index 28): "— WASSILY KANDINSKY"

**Canonical surface form `"Wassily Kandinsky"`** — substring match count: **1**
Example sentences (verbatim):
- (chunk_id `fc288901-07c2-45bf-9e6e-a7656bce29f6`, chunk_index 28): "— WASSILY KANDINSKY"

### `Professor Frankl` → `Viktor E. Frankl`
- row id: `6ca5a223-ad35-42ed-a3d5-f5455ee5379f`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Professor Frankl"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Professor Viktor E. Frankl` → `Viktor E. Frankl`
- row id: `23a9a939-e893-4776-903f-98c51e98d267`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Professor Viktor E. Frankl"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Sigmund Freud` → `Freud`
- row id: `cd05c113-806d-4f89-86ab-1a482d945100`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **12**
**Alias surface form `"Sigmund Freud"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `9609ce0d-34ab-4b34-b3de-339437f59026`, chunk_index 86): "First of all, what I have described already 30 years ago, and predicted and foreseen, I might say: the emergence—and today the presence—of what I call the existential vacuum ; the feeling of meaninglessness; the feeling of emptiness; a sense of futility which now takes the place of inferiority feelings; the existential frustration which now takes the place of sexual frustrations, in contrast to the times of Sigmund Freud."
- (chunk_id `b32b2d34-b02d-446c-8b59-fd38a3716e16`, chunk_index 115): "So the belief of Sigmund Freud that religion is a neurosis of mankind may, in a way, be reversed, inasmuch as we may come across cases in which, on the contrary, a neurosis is the result of a repressed religious desire and longing in an individual."
- (chunk_id `bc99a92b-f173-4c57-9767-2039de00d28c`, chunk_index 122): "In a letter to Hans Blüher * in 1923, Sigmund Freud spoke of “this upside-down time of ours.” But even today there is still a lot of talk about a “sickness of our times,” an illness of the zeitgeist, a zeitgeist pathology. ** Might this sickness of our times be identical to the one that all psychotherapy is concerned with—neurosis?"

**Canonical surface form `"Freud"`** — substring match count: **14**
Example sentences (verbatim):
- (chunk_id `f3370748-dda9-4c23-8885-6843b8f63db0`, chunk_index 31): "And that’s not just in the sense of the two big goals in life that Freud defined in psychoanalysis, his own theory and therapy, which are the ability to work and the capacity for pleasure; but we must also get to grips with the human being’s capacity for suffering."
- (chunk_id `9609ce0d-34ab-4b34-b3de-339437f59026`, chunk_index 86): "First of all, what I have described already 30 years ago, and predicted and foreseen, I might say: the emergence—and today the presence—of what I call the existential vacuum ; the feeling of meaninglessness; the feeling of emptiness; a sense of futility which now takes the place of inferiority feelings; the existential frustration which now takes the place of sexual frustrations, in contrast to the times of Sigmund Freud."
- (chunk_id `db40143b-9a2d-4f28-8f6e-6003034b9a64`, chunk_index 103): "FRANKL : You see, many years ago, I once was lecturing at one of the American universities, and a Freudian stood up in the question-and-answer period and told me, “Dr. Frankl, I just returned from Moscow."

### `Tobias` → `Tobias Esch`
- row id: `3b4aed1e-e521-4171-9b2a-387b2fb5ff2d`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Tobias"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Introduction copyright © 2023 Tobias Esch"

**Canonical surface form `"Tobias Esch"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Introduction by Dr. Tobias Esch"
- (chunk_id `fda7f713-98ed-4eaf-813c-2575c8cd77f0`, chunk_index 27): "— DR. TOBIAS ESCH Spring 2023"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Introduction copyright © 2023 Tobias Esch"

### `Vasily Kandinsky` → `Wassily Kandinsky`
- row id: `67140153-0970-4d66-8ae5-7c49b0009126`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **1**
**Alias surface form `"Vasily Kandinsky"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Wassily Kandinsky"`** — substring match count: **1**
Example sentences (verbatim):
- (chunk_id `fc288901-07c2-45bf-9e6e-a7656bce29f6`, chunk_index 28): "— WASSILY KANDINSKY"

### `Vesely` → `Alexander Vesely-Frankl`
- row id: `0669a314-ff59-45a2-ba58-170054bf1bfd`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Vesely"`** — substring match count: **6**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `6280af63-d322-41c5-9a01-b237e1ab1155`, chunk_index 76): "* Transcribed and edited by Franz Vesely-Frankl, April 2022."

**Canonical surface form `"Alexander Vesely-Frankl"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Foreword copyright © 2023 Alexander Vesely-Frankl"

### `Vesely-Frankl` → `Alexander Vesely-Frankl`
- row id: `a2e9be78-6f30-4006-925e-bc4ec76a4061`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **3**
**Alias surface form `"Vesely-Frankl"`** — substring match count: **6**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `6280af63-d322-41c5-9a01-b237e1ab1155`, chunk_index 76): "* Transcribed and edited by Franz Vesely-Frankl, April 2022."

**Canonical surface form `"Alexander Vesely-Frankl"`** — substring match count: **4**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Foreword by Alexander Vesely-Frankl"
- (chunk_id `2d616755-e56c-4d02-a01f-a6b4842a49e4`, chunk_index 12): "— ALEXANDER VESELY-FRANKL Vienna, January 2024"
- (chunk_id `b13d1b6a-79a7-4d42-939d-40fc80369804`, chunk_index 196): "Foreword copyright © 2023 Alexander Vesely-Frankl"

### `Victor Frankl` → `Viktor E. Frankl`
- row id: `8555988b-2354-452b-add2-7406bf8d250a`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Victor Frankl"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Viktor` → `Viktor E. Frankl`
- row id: `65ecb2d5-720f-441b-a46d-f9b8089f848e`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Viktor"`** — substring match count: **47**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Man Alive—Viktor Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Viktor E.` → `Viktor E. Frankl`
- row id: `f933c97e-65c3-4f62-957a-9d3dc0ff238c`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Viktor E."`** — substring match count: **18**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Viktor Emil Frankl` → `Viktor E. Frankl`
- row id: `b9a675bd-c423-458d-aa04-3bf8201a7129`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Viktor Emil Frankl"`** — substring match count: **0**
No occurrences found — no example sentences.

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `Viktor Frankl` → `Viktor E. Frankl`
- row id: `038b592f-5533-42d1-bfdd-96a00caf46d0`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **14**
**Alias surface form `"Viktor Frankl"`** — substring match count: **21**
Example sentences (verbatim):
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Man Alive—Viktor Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About the Viktor Frankl Institute"
- (chunk_id `19dc0be2-1410-4478-85ce-2ebf505763fb`, chunk_index 2): "M y grandfather Viktor Frankl was a cheerful and loving man, dedicated to his role as a medical doctor."

**Canonical surface form `"Viktor E. Frankl"`** — substring match count: **17**
Example sentences (verbatim):
- (chunk_id `b0bca9d5-002c-42a4-85fa-9da549dac41b`, chunk_index 0): "ALSO BY VIKTOR E. FRANKL"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "About Viktor E. Frankl"
- (chunk_id `d53dbf4f-f67b-40ae-8ea4-ad8f0aecb712`, chunk_index 1): "Further Works by Viktor E. Frankl"

### `WASSILY KANDINSKY` → `Wassily Kandinsky`
- row id: `ebeb190e-846d-4f37-a833-d87ffc41a7af`
- source: `auto` | kind: `name` | source_query: `None`
- created_at (epoch ms): `1786202674083`
- stored `mentions` column value: **1**
**Alias surface form `"WASSILY KANDINSKY"`** — substring match count: **1**
Example sentences (verbatim):
- (chunk_id `fc288901-07c2-45bf-9e6e-a7656bce29f6`, chunk_index 28): "— WASSILY KANDINSKY"

**Canonical surface form `"Wassily Kandinsky"`** — substring match count: **1**
Example sentences (verbatim):
- (chunk_id `fc288901-07c2-45bf-9e6e-a7656bce29f6`, chunk_index 28): "— WASSILY KANDINSKY"

## Additional raw observations (facts only, no verdicts)
- Alias surface forms with **zero** substring matches found anywhere in the book's 198 chunks: `Dr. Esch`, `Dr. Freud`, `Dr. Viktor E. Frankl`, `Professor Frankl`, `Professor Viktor E. Frankl`, `Vasily Kandinsky`, `Victor Frankl`, `Viktor Emil Frankl`, `Joel Young`. That is 9 of the 25 rows.
- All 25 rows have `source = 'auto'`, `kind = 'name'`, and the identical `created_at` timestamp `1786202674083` (i.e. all inserted in one batch).
- Canonical `Young` (from alias rows `Joel` and `Joel Young`): the surface form `Young` matches 29 times in the book text. Every example found in the first 3 matches (and, per manual grep during this task, effectively all matches earlier in the book) is the common English word "young"/"younger"/"youngsters," not a person's surname. The only place a person actually named "Young" appears in the book text is chunk_index 196 (back-matter / copyright page): "Translation © Joelle Young 2024" and "Joelle Young has asserted her right to be identified as the translator of this work..." — the translator's name is **Joelle Young**, not "Joel Young."
- Alias `Joel` (surface form, case-insensitive substring): the only 2 matches in the whole book are both inside the word "Joelle" in that same chunk 196 copyright-page text ("Joelle Young"), i.e. `Joel` matches as a leading substring of `Joelle`, not as a standalone token.
- Alias `Vesely` (→ canonical `Alexander Vesely-Frankl`): one of its 6 substring matches (chunk_index 76) is inside the name "Franz Vesely-Frankl," a person distinct from "Alexander Vesely-Frankl" who is also referred to in the book ("Transcribed and edited by Franz Vesely-Frankl, April 2022"). The same is true for alias `Vesely-Frankl`, which shares the identical 6-match/3-example result set including that chunk 76 occurrence.
- Alias `Frankl` (→ canonical `Viktor E. Frankl`): substring match count is 142. A precise recount of the substring `Vesely-Frankl` alone (case-insensitive) = 6 across chunk_index 1, 12, 76 (×1 each) and 196 (×3) — all 6 of those are included in the 142 "Frankl" total, as "Frankl" is a substring of "Vesely-Frankl." Of those 6: 4 are the exact phrase "Alexander Vesely-Frankl," 1 is "Franz Vesely-Frankl" (chunk_index 76, "Transcribed and edited by Franz Vesely-Frankl, April 2022" — a person distinct from Alexander), and 1 (chunk_index 196, a library-catalog-style line: "Names: Frankl, Viktor E. (Viktor Emil), 1905–1997 author. | Vesely-Frankl, Alexande[r]...") is Alexander's surname alone, without "Alexander" immediately preceding it (catalog last-name-first ordering).
- Canonical `Freud` (→ from aliases `Dr. Freud`, `Sigmund Freud`): substring count 14 includes 4 occurrences that are inside the word "Freudian" rather than the bare name "Freud" (chunk_index 103, 140, 141, 163, one occurrence each).
- Three separate alias rows map to canonical `Viktor E. Frankl` with a stored `mentions` value of 14 but a live substring recount of 17 for the exact string `Viktor E. Frankl` (applies to all 13 alias rows whose canonical is `Viktor E. Frankl`: `Dr. Frankl`, `Dr. Viktor E. Frankl`, `Frankl`, `Professor Frankl`, `Professor Viktor E. Frankl`, `Victor Frankl`, `Viktor`, `Viktor E.`, `Viktor Emil Frankl`, `Viktor Frankl`).
- Similarly, canonical `Tobias Esch` has stored `mentions = 3` on every alias row pointing to it, but a live recount of the exact string `Tobias Esch` = 4.
- Similarly, canonical `Freud` has stored `mentions = 12` on every alias row pointing to it, but a live recount of the exact string `Freud` = 14.
- Similarly, canonical `Alexander Vesely-Frankl` has stored `mentions = 3`, live recount of `Alexander Vesely-Frankl` = 4.
- Similarly, canonical `Young` has stored `mentions = 21`, live recount of the bare word `Young` (case-insensitive substring, matches the common adjective as noted above) = 29.
- Canonical `Wassily Kandinsky` and `Kandinsky` / `WASSILY KANDINSKY` / `Vasily Kandinsky`: stored `mentions = 1`, live recount of `Wassily Kandinsky` = 1, and the entire footprint of this person in the book is a single epigraph attribution line at chunk_index 28: "— WASSILY KANDINSKY" (no other text about this person elsewhere in the 198 chunks).
- Alias surface forms that duplicate the canonical's own words as a common English word or otherwise ambiguous short token: `Young` (canonical, common adjective/noun), and case-only variants exist as separate rows (`Kandinsky` vs. `WASSILY KANDINSKY` are two different rows with the same canonical, differing only in case; likewise `Alexander` and `Alexander Vesely` are two different rows for the same canonical).
- Canonical names in this table are not exclusively point-of-view character names: `Alexander Vesely-Frankl` is the author's grandson and the book's foreword writer, `Tobias Esch` is the introduction's author, `Wassily Kandinsky` is an epigraph source (painter, quoted once), and `Freud` is a historical figure discussed in the book's argument, not a character in a narrative.
- No two distinct alias rows point to different canonicals for what looks like the same underlying surface form in this table — the ambiguity found (`Young`/`Joelle Young` vs. the adjective "young"; `Frankl` vs. `Vesely-Frankl`) is between an alias/canonical value and unrelated text in the book, not between two alias rows disagreeing with each other.
