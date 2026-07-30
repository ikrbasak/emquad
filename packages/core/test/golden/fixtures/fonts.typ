// Several registered families and weights. The failure this guards against is
// substitution: asking for a family that is not registered yields a valid PDF
// set in something else entirely.
#set page(width: 120mm, height: 70mm, margin: 8mm)

#set text(font: "Libertinus Serif", size: 11pt)
Libertinus Serif regular, *bold*, _italic_, and *_bold italic_*.

#set text(font: "New Computer Modern", size: 11pt)
New Computer Modern regular and *bold*.

#set text(font: "DejaVu Sans Mono", size: 9pt)
DejaVu Sans Mono 0123456789 `code`.

#set text(font: "New Computer Modern Math", size: 11pt)
$ sum_(i=1)^n i = (n(n+1))/2 $
