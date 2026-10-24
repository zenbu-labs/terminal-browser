import { expect, test } from 'claude-code/testing'
import { paneUrl } from './urls.ts'

test('a pane takes ordinary web addresses as given', () => {
  expect(paneUrl('example.com')).toBe('https://example.com')
  expect(paneUrl('localhost:3000/app')).toBe('http://localhost:3000/app')
  expect(paneUrl('https://a.test/search?q=caf%C3%A9&lang=pt')).toBe('https://a.test/search?q=caf%C3%A9&lang=pt')
  expect(paneUrl('terminal-browser://start')).toBe('terminal-browser://start')
})

test('a pane refuses schemes that run code and characters no url may hold', () => {
  for (const raw of [
    'https://a.test/|whoami',
    'https://a.test/"x',
    'https://a.test/^x',
    'https://a.test/<x>',
    'https://a.test/`x`',
    'https://a.test/%PATH%',
    'https://a.test/a b',
    'https://a.test/\nnext',
    'javascript:alert(1)',
    'cmd:/c calc',
  ]) {
    expect(paneUrl(raw)).toBe(null)
  }
})
