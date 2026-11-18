# Tables

## Every alignment

| left | centre | right | unset |
| :--- | :----: | ----: | ----- |
| a | b | c | d |
| longer cell | x | 42 | |

## A cell holding an escaped pipe

| pattern | meaning |
| --- | --- |
| `a \| b` | either a or b |
| plain \| pipe | the pipe is text |

## Cells holding inline constructs

| what | where |
| --- | --- |
| `renderMarkdown` | [site.js](../lib/site.js) |
| **strong** and *emphasis* | <script>escaped</script> |

## Ragged rows, padded and truncated to the header

| one | two | three |
| --- | --- | --- |
| short |
| a | b | c | d |

## Without leading and trailing pipes

id | title
--- | ---
1 | first
2 | second

## A line with pipes that is not a table

This paragraph | has a pipe | but no delimiter row, so it stays a paragraph.

## A table that ends at a heading

| k | v |
| --- | --- |
| a | 1 |

## After the table
