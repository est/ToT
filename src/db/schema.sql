CREATE TABLE IF NOT EXISTS ai_models (
  id            TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  endpoint      TEXT NOT NULL DEFAULT '/v1/chat/completions',
  api_format    TEXT NOT NULL DEFAULT 'openai',
  api_key       TEXT,
  model_id      TEXT NOT NULL,
  display_name  TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  meta          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_model ON ai_models(base_url, model_id);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New Chat',
  focus_id   BLOB,
  meta       TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_nodes (
  conversation_id TEXT NOT NULL,
  id              BLOB NOT NULL,
  parents         TEXT NOT NULL DEFAULT '',
  user_content    TEXT NOT NULL,
  user_meta       TEXT DEFAULT '{}',
  assistant_content TEXT NOT NULL DEFAULT '',
  assistant_meta  TEXT DEFAULT '{}',
  meta            TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, id)
);

CREATE INDEX IF NOT EXISTS idx_node_conv ON chat_nodes(conversation_id);
CREATE INDEX IF NOT EXISTS idx_node_parents ON chat_nodes(conversation_id, parents);
