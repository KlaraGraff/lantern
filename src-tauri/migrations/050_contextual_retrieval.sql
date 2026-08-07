-- 身份句：模型为这个 chunk 写的一行「它是从哪来的、在讲什么」。
-- 与 book_chunks 的其余列一样是设备本地派生数据，不进同步容器。
ALTER TABLE book_chunks ADD COLUMN context_line TEXT;
ALTER TABLE book_chunks ADD COLUMN context_model TEXT;
ALTER TABLE book_chunks ADD COLUMN context_at INTEGER;

-- 让向量的失效判断能看见身份句的变化。空串表示「embed 时没有身份句」。
ALTER TABLE book_chunk_embeddings ADD COLUMN context_sha256 TEXT NOT NULL DEFAULT '';
