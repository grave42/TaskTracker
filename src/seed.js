export function seed(s) {
  const a = s.createTask({
    title: 'Подключить OAuth-вход через GitHub',
    description: 'Нужен вход через GitHub для веб-приложения.\n\nAcceptance:\n- кнопка «Войти»\n- сессия в cookie\n- выход',
    priority: 'high', labels: ['auth', 'backend'],
  }, 'human');
  s.updateTask(a.id, { status: 'in_progress', assignee: 'claude-backend' }, 'claude-backend');
  s.addComment(a.id, 'Взял в работу. Начинаю с callback-роута, потом сессии.', 'claude-backend');
  s.askQuestion({
    task_id: a.id,
    question: 'Где хранить сессии?',
    context: 'Вариант с cookie-JWT проще и не требует хранилища, но токен нельзя отозвать до истечения срока. Серверные сессии в SQLite дают мгновенный logout. Я бы выбрал SQLite.',
    options: ['Cookie-JWT', 'Сессии в SQLite'], urgency: 'blocking',
  }, 'claude-backend');

  const b = s.createTask({ title: 'Тёмная тема для дашборда', priority: 'low', labels: ['ui'] }, 'human');
  s.askQuestion({
    task_id: b.id,
    question: 'Тёмная тема должна следовать системной настройке или переключаться вручную?',
    context: 'Могу сделать оба: авто по умолчанию + ручной переключатель в шапке.', urgency: 'normal',
  }, 'codex-ui');

  const c = s.createTask({ title: 'Написать e2e тесты на логин', priority: 'normal', labels: ['qa'] }, 'human');
  s.updateTask(c.id, { status: 'review', assignee: 'codex-qa' }, 'codex-qa');
  s.addComment(c.id, 'Готово: 12 сценариев, все зелёные. Покрыты ошибки сети и просроченная сессия.', 'codex-qa');

  const d = s.createTask({ title: 'Настроить CI на GitHub Actions', priority: 'normal', labels: ['devops'] }, 'human');
  s.updateTask(d.id, { status: 'done', assignee: 'claude-devops' }, 'claude-devops');
  s.createTask({ title: 'Ограничить частоту запросов к API (rate limit)', description: 'Защита от перебора на /login.', priority: 'urgent', labels: ['security'] }, 'human');
  s.createTask({ title: 'Обновить README: раздел про деплой', priority: 'low', labels: ['docs'] }, 'claude-docs');
}
