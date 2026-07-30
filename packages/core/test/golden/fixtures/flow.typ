// Multi-page flow with a running header and page numbers.
#set page(
  width: 100mm, height: 70mm, margin: 10mm,
  header: align(right, text(8pt, fill: luma(40%))[emquad golden]),
  footer: align(center, text(8pt)[#context counter(page).display()]),
)
#set text(font: "Libertinus Serif", size: 10pt)

#for i in range(0, 6) [
  == Section #i
  #lorem(40)
]
