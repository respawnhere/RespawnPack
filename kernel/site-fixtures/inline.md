# Inline constructs

Emphasis with *stars* and _underscores_, strong with **double stars** and __double underscores__,
and the nested case *outer text with **inner strong** inside it*. An identifier such as
snake_case_name keeps both of its underscores, because `_` never opens inside a word.

Inline code holds `a < b && c > d` verbatim, a double run ``a ` b`` holds a backtick of its own,
and a padded span `` ` `` is a single backtick.

A relative link to [the guide](guide.md), one with a title [the index](index.md "The index page"),
an absolute link to [example](https://example.test/a.md), a fragment [to this section](#inline-constructs),
a root-relative [docs entry](/docs/setup.md?view=raw#top), and a destination carrying balanced
parentheses [the article](https://en.wikipedia.org/wiki/Foo_(bar)).

An autolink <https://example.test/path?q=1> and an email autolink <someone@example.test>.

An image ![a flow diagram](img/flow.png "Flow") and an image inside a link
[![build badge](img/badge.svg)](https://example.test/status).

Raw HTML is text and never markup: <script>alert("x")</script>, <b>not bold</b>, and a bare < with
a bare > beside it.

A link whose scheme is outside the allow list is left as text: [click](javascript:alert(1)). So is
an autolink with the same scheme: <javascript:alert(1)>.

An inline comment <!-- this text is dropped --> leaves the sentence joined around it.

Escapes: \*not emphasis\*, \_not emphasis\_, \`not code\`, \[not a link\], and \# not a heading.

A hard break made with a trailing backslash\
puts this sentence on its own line. The two-space form is proved in the suite instead, because a
committed fixture may not carry trailing whitespace.

A reference link [like this][ref] is not modelled, so both halves stay text, and so does a
footnote marker[^1].
