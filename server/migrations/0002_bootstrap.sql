-- ============================================================================
-- SHELTER server — bootstrap-данные (идемпотентно)
-- ============================================================================

-- Канал обновлений по умолчанию: stable (TZ: числовые версии X.Y.Z).
INSERT INTO app_settings (key, value)
VALUES ('updates_channel', 'stable')
ON CONFLICT (key) DO NOTHING;

-- Принудительное обновление отключено, пока админ не задаст версию явно.
INSERT INTO app_settings (key, value)
VALUES ('updates_min_client_version', '')
ON CONFLICT (key) DO NOTHING;
