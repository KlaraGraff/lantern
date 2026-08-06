-- 每月、每功能的 AI 请求次数计数器。
--
-- 与 ai_usage_records（036）不同：那张表按 token 用量记账，且只有 provider
-- 真的返回了 usage 对象才会落一行，会漏记。这张表只回答一个更朴素的问题——
-- 「这个月点了多少次 AI」——在一次用户可见的请求发起时加一，与是否拿到
-- usage、是否跨 provider/凭据故障转移重试无关。
--
-- month 用本地日期的 '%Y-%m'（例如 '2026-08'），不是 UTC——用户关心的是
-- 自己时区里的「这个月」。feature 是稳定的英文 slug（'dictionary' /
-- 'explain' / 'translate' / 'chat' / 'xray' / 'review' / 'autoAnalysis'），
-- 前端按 slug 做 i18n 展示，slug 本身一旦选定不再改名。
CREATE TABLE IF NOT EXISTS ai_request_counts (
  month TEXT NOT NULL,
  feature TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, feature)
);
CREATE INDEX IF NOT EXISTS idx_ai_request_counts_month ON ai_request_counts(month);
