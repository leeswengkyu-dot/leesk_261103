-- 중복 후보 AI 1차 판단 결과 (same | different | unsure). 제안일 뿐이며 확정은 사람이 한다
ALTER TABLE duplicate_candidates ADD COLUMN ai_verdict TEXT;
ALTER TABLE duplicate_candidates ADD COLUMN ai_confidence INTEGER;
ALTER TABLE duplicate_candidates ADD COLUMN ai_reason TEXT;
ALTER TABLE duplicate_candidates ADD COLUMN ai_checked_at TEXT;
