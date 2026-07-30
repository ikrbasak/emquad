// PNG, JPEG, and SVG in one document. Three separate decode paths in typst,
// and an image that fails to decode does not fail the compile — it just is not
// there.
#set page(width: 120mm, height: 60mm, margin: 8mm)
#set text(font: "Libertinus Serif", size: 10pt)

#grid(
  columns: 3,
  gutter: 8pt,
  image("/assets/logo.png", width: 24mm),
  image("/assets/photo.jpg", width: 24mm),
  image("/assets/mark.svg", width: 24mm),
)

PNG, JPEG, SVG.
