# Edges, and what the subset does not model

Everything this renderer does not understand arrives on the page as escaped text. Nothing below is
dropped, and nothing below becomes markup.

## Raw HTML blocks

<div class="wrapper">
  <p>An HTML block is text.</p>
</div>

<script>
window.location = "https://elsewhere.test";
</script>

<img src="x" onerror="alert(1)">

## Syntax borrowed from other tools

:::note
A directive block from another renderer.
:::

{% raw %}A template tag.{% endraw %}

[[A wiki link]]

$$
E = mc^2
$$

## Front matter, which this subset reads as a rule and a paragraph

---
title: not parsed as metadata
---

## Angle brackets that are not tags

The comparison a < b and the comparison b > a, an arrow -> and an ampersand & on its own, plus an
already-escaped entity &amp; that stays exactly as typed.

## Headings with nothing a slug can use

### ⛔

### ⛔

## Emphasis that does not pair

A lone * star, a lone _ underscore, and a *run that never closes.

## An unterminated comment

<!-- this comment never closes
so both of these lines stay on the page

## An empty list item and a bare marker

-
- second

## A link with an empty destination

[nothing here]() and [a bare label] with no target.
