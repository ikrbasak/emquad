// A table long enough to break across pages, so header repetition is exercised.
// Repeated headers are a classic silent-wrong-output case: the PDF is valid
// either way, and only a rendered comparison notices the header vanished.
#set page(width: 120mm, height: 90mm, margin: 10mm)
#set text(font: "Libertinus Serif", size: 9pt)

= Line items

#table(
  columns: (1fr, auto, auto),
  stroke: 0.5pt + rgb("#888888"),
  fill: (_, y) => if y == 0 { rgb("#eeeeff") },
  table.header([*Item*], [*Qty*], [*Price*]),
  ..range(0, 22).map(i => ([Widget #i], [#(i + 1)], [#(i * 3 + 4).00])).flatten(),
)
