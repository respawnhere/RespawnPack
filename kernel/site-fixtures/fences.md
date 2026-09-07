# Fenced and indented code

## A fence with a language

```bash
set -euo pipefail
echo "hello" | tr a-z A-Z
```

## A fence whose info string carries more than one word

```js title="example.js" highlight=1
const answer = 40 + 2;
```

## A fence with no info string

```
plain text, no language class
```

## A four-backtick fence holding a three-backtick fence

````markdown
```bash
echo "the inner fence is content, not a closer"
```
````

## A tilde fence, which may hold backticks freely

~~~text
``` still content ```
~~~

## A longer tilde fence closed by a longer run

~~~~yaml
key: value
~~~~

## Code is escaped, never markup

```html
<script>alert("not executed")</script>
<b>&amp; not an entity</b>
```

## An indented code block

    function indented() {
      return "<b>escaped</b>";
    }

## A fence indented under a heading

  ```sh
  echo "opened at two spaces, dedented by two"
  ```

## An unclosed fence, which runs to the end of the document

```python
print("nothing after this line closes the fence")
print("so both lines are code")
