import { describe, expect, it } from 'vitest';
import { parseForumList, parseTopicPage } from '../fetch-forum.mjs';
import { renderTopic } from '../prepare-forum.mjs';

const LIST = `<html><body><a href="https://forum.insert.com.pl/index.php?/topic/112435-konfiguracja-z-ksef/">a</a>
<a href="https://forum.insert.com.pl/index.php?/topic/112435-konfiguracja-z-ksef/#comments">a</a>
<a href="https://forum.insert.com.pl/index.php?/topic/13652-witamy/">b</a>
<li class="ipsPagination_pageJump"><a>Strona 1 z 123</a></li></body></html>`;

const post = (role, time, body) => `<article class="cPost"><aside class="cAuthorPane"><ul class="cAuthorPane_info"><li>${role === 'staff' ? '<img src="/uploads/grupa_insert.png">' : 'Użytkownik'}</li></ul></aside>
<time datetime="${time}"></time><div data-role="commentContent"><blockquote>cytat</blockquote>${body}</div></article>`;
const TOPIC = `<html><body><h1>Chmurka KSeF na czerwono</h1><li class="ipsPagination_pageJump"><a>Strona 1 z 2</a></li>
${post('user', '2026-07-17T11:30:04Z', '<p>Po zalogowaniu chmurka KSeF jest na czerwono, mimo że wczoraj była zielona.</p>')}
${post('user', '2026-07-17T11:35:45Z', '<p>Co oznacza pulpit zdalny?</p>')}
${post('staff', '2026-07-24T09:20:31Z', '<p>Proszę zweryfikować aktualizację programu i certyfikat KSeF.</p>')}
</body></html>`;

describe('fetch-forum: parsery', () => {
  it('lista wątków: unikalne id, liczba stron', () => {
    const r = parseForumList(LIST);
    expect(r.topics.map((t) => t.id)).toEqual([112435, 13652]);
    expect(r.pages).toBe(123);
  });
  it('wątek: tytuł, strony, posty z rolą (ikona grupy = InsERT), bez cytatów', () => {
    const t = parseTopicPage(TOPIC);
    expect(t.title).toBe('Chmurka KSeF na czerwono');
    expect(t.pages).toBe(2);
    expect(t.posts.map((p) => p.role)).toEqual(['użytkownik', 'użytkownik', 'InsERT']);
    expect(t.posts[0].text).not.toContain('cytat');
  });
});

describe('prepare-forum: renderTopic', () => {
  it('pytanie + odpowiedzi z rolą i datą, bez nazwisk; odpowiedzi InsERT zachowane', () => {
    const t = { ...parseTopicPage(TOPIC), url: 'https://forum.insert.com.pl/index.php?/topic/112435-x/', sectionName: 'Subiekt GT' };
    const r = renderTopic(t);
    expect(r.year).toBe('2026');
    expect(r.hasStaff).toBe(true);
    expect(r.text).toContain('## Chmurka KSeF na czerwono');
    expect(r.text).toContain('**Pytanie (użytkownik, 2026-07-17):** Po zalogowaniu');
    expect(r.text).toContain('**Odpowiedź (InsERT, 2026-07-24):** Proszę zweryfikować');
    expect(r.text).not.toMatch(/Dettlaff|Dyszkiewicz/);
  });
  it('wątek bez odpowiedzi → null', () => {
    expect(renderTopic({ title: 'x', posts: [{ role: 'użytkownik', time: '2026-01-01', html: '<p>samo pytanie bez odpowiedzi</p>', text: 'samo pytanie bez odpowiedzi' }] })).toBeNull();
  });
});
