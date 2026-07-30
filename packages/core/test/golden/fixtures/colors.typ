// Colors and gradients. Gradients are rasterized rather than described, so a
// change in how they are emitted shows up in pixels and nowhere else.
#set page(width: 120mm, height: 60mm, margin: 8mm)
#set text(font: "Libertinus Serif", size: 10pt)

#rect(width: 100%, height: 12mm, fill: gradient.linear(rgb("#1a3a5a"), rgb("#ffcc33")))
#v(4mm)
#grid(
  columns: 4,
  gutter: 4pt,
  ..("#c0392b", "#27ae60", "#2980b9", "#8e44ad").map(c =>
    rect(width: 20mm, height: 8mm, fill: rgb(c))
  ),
)
#v(2mm)
#text(fill: rgb("#c0392b"))[Colored text] and #text(fill: luma(40%))[gray text].
