CREATE TABLE book_field_clocks (
    book_id TEXT NOT NULL,
    field TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by_device TEXT NOT NULL,
    PRIMARY KEY (book_id, field)
);

-- Existing libraries start each field at its current row clock. Past field
-- history cannot be recovered; values and reader annotations remain untouched.
INSERT INTO book_field_clocks
SELECT id, 'title', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'author', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'description', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'cover_path', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'genre', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'pages', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'source', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'progress', updated_at, updated_by_device FROM books
UNION ALL
SELECT id, 'status', updated_at, updated_by_device FROM books;

-- Birth clocks belong to each field; subsequent updates are stamped by the
-- sync writer or the field merge, never by the book's aggregate timestamp.
CREATE TRIGGER book_field_clocks_insert AFTER INSERT ON books BEGIN
    INSERT INTO book_field_clocks SELECT NEW.id, 'title', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'author', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'description', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'cover_path', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'genre', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'pages', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'source', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'progress', NEW.updated_at, NEW.updated_by_device
    UNION ALL SELECT NEW.id, 'status', NEW.updated_at, NEW.updated_by_device;
END;
CREATE TRIGGER book_field_clocks_delete AFTER DELETE ON books BEGIN
    DELETE FROM book_field_clocks WHERE book_id = OLD.id;
END;
