# Reference photos for the Luxor sample

`raw/` holds the photos as cropped; the files beside this one are the same photos after
`python3 scripts/reference_tones.py references/luxor/raw references/luxor`, which flattens their light and brings
their stone to the colour of the first. Only the toned ones are sent to the image model.

| File | Source | Author | Licence |
|---|---|---|---|
| 02_wall_relief.jpg | https://commons.wikimedia.org/wiki/File:Detalles_del_templo-luxor-2007.JPG | Alberto-g-rovi | CC BY-SA 3.0 |
| 03_column_shafts.jpg | https://commons.wikimedia.org/wiki/File:Columnas_del_templo-luxor-2007.JPG | Alberto-g-rovi | CC BY-SA 3.0 |
| 04_relief_corridor.jpg | https://commons.wikimedia.org/wiki/File:1550-1070_v._Chr._entstand_der_Luxor-Tempel._02.jpg | Holger Uwe Schmitt | CC BY-SA 4.0 |
| 05_relief_detail.jpg | https://commons.wikimedia.org/wiki/File:1550-1070_v._Chr._entstand_der_Luxor-Tempel._05.jpg | Holger Uwe Schmitt | CC BY-SA 4.0 |

All are cropped and, outside `raw/`, changed in tone.

The historical first reference, `01_hypostyle_columns.jpg`, is omitted because its source and license were unknown. The public look file uses the four attributed photographs above.
