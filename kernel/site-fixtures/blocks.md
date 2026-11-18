# Block constructs

## A second level

### A third level

#### A fourth level

##### A fifth level

###### A sixth level

## A second level

The heading above repeats an earlier one, so its anchor takes a numeric suffix and the two stay
distinct.

## Heading with `inline code` and a [link](other.md)

## Heading with a closing hash run ##

A paragraph that runs
across three source lines
joins into one, with the leading spaces of its continuation lines removed.

> A blockquote with **strong text** and a [relative link](guide.md).
> Its second line carries the marker.
> A third line, and then a lazy continuation that carries none.
lazy continuation line

> A second blockquote, holding a list:
>
> - first
> - second

Thematic breaks, in all three spellings:

---

***

___

An indented code block, which starts four spaces in and keeps every character it holds:

    <script>not markup</script>
    - not a list
    still code

A paragraph after the code block.

#not-a-heading, because ATX needs a space after its hashes.

<!-- A whole-line comment is dropped. -->

<!--
A multi-line comment
is dropped as well.
-->

A paragraph after the comments, to prove the drop consumed nothing else.
