CREATE TABLE book_manual_order (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    position INTEGER NOT NULL
);
