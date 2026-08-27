---
name: web-research
description: How to answer a question from the web without inventing the answer. Use when a question needs a source rather than recall.
---

# Web research

Two capabilities, in this order, always.

## 1. Search for candidates

`web-search` returns titles, URLs and snippets. That is all it returns, on
purpose: it does not summarise and it does not answer. A snippet tells you
whether a page is worth opening and nothing more.

Search with the words that would appear on the page you want, not the words
of the question. "default value of X in version 4" finds documentation;
"what is the default of X" finds forum posts asking the same thing.

If the first search returns nothing usable, change the wording rather than
the count. Ten bad results are not better than three.

## 2. Read the page

`web-fetch` fetches one page and answers a question about it from the page's
own text. Ask it the specific thing you need, not "summarise this": a narrow
question gets a quotable answer, and a summary gets you a second thing to
verify.

Open the two or three most promising results, not all of them. If they
agree, you are done. If they disagree, say so and say which you believe.

## What the allowlist means

Both capabilities only reach hosts the project's owner listed in
`WEB_FETCH_ALLOWED_HOSTS`. A refusal is a configuration boundary, not a
failure and not something to work around. Name the host you wanted and why,
and let a person decide whether to add it.

A fresh project has an empty allowlist and can reach nothing at all. That is
the intended starting state.

## Answering

Answer from what the page said, and say where it came from. Quote the
sentence that settles the question when there is one.

When the pages do not answer it, say that. An honest "I could not find this;
here is what I looked at" is a useful answer. A confident synthesis of three
snippets is not.
