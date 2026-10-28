# Wallpaper credits

All wallpapers are bundled in `images/wallpapers/` (cropped to 16:9, resized to 3840×2160 (4K UHD) from originals at least 3840 px wide, JPEG-recompressed, never softened).
They come from Wikimedia Commons under free licenses that allow redistribution, including commercial use, with attribution
(CC0 needs none). Share-alike (BY-SA) images: the resized copies here are distributed under the same license as the original.
The launcher also shows each photographer and license on screen next to the location caption.

| # | File | Location | Photographer | License | Source |
|---|---|---|---|---|---|
| 1 | `moraine-lake.jpg` | Moraine Lake, Banff, Canada | Chensiyuan | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [Commons](https://commons.wikimedia.org/wiki/File:1_moraine_lake_pano_2019.jpg) |
| 2 | `matterhorn.jpg` | Matterhorn & Riffelsee, Zermatt, Switzerland | Deralpinbergsteiger | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [Commons](https://commons.wikimedia.org/wiki/File:Matterhorn_reflection_in_the_Riffelsee_at_sunrise.jpg) |
| 3 | `arashiyama.jpg` | Togetsu-kyō Bridge, Arashiyama, Kyoto, Japan | Basile Morin | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [Commons](https://commons.wikimedia.org/wiki/File:Togetsu-kyo_bridge_at_dusk,_Kyoto,_Japan.jpg) |
| 4 | `maldives.jpg` | Dhaalu Atoll, Maldives | Ishan (@seefromthesky) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | [Commons](https://commons.wikimedia.org/wiki/File:An_island_in_the_beautiful_atoll_of_Dhaalu_(Unsplash).jpg) |
| 5 | `geiranger.jpg` | Geirangerfjord, Norway | Diego Delso | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [Commons](https://commons.wikimedia.org/wiki/File:Fiordo_de_Geiranger_desde_Flydalsjuvet,_Noruega,_2019-09-07,_DD_59.jpg) |
| 6 | `santorini.jpg` | Oia, Santorini, Greece | C messier | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [Commons](https://commons.wikimedia.org/wiki/File:%CE%9F%CE%AF%CE%B1_1121.jpg) |
| 7 | `yosemite.jpg` | Tunnel View, Yosemite National Park, California | Diliff | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | [Commons](https://commons.wikimedia.org/wiki/File:Tunnel_View,_Yosemite_Valley,_Yosemite_NP_-_Diliff.jpg) |
| 8 | `yellowstone.jpg` | Grand Prismatic Spring, Yellowstone, Wyoming | Carsten Steger | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [Commons](https://commons.wikimedia.org/wiki/File:Aerial_image_of_Grand_Prismatic_Spring_(view_from_the_south).jpg) |
| 9 | `na-pali.jpg` | Nā Pali Coast, Kauaʻi, Hawaiʻi | dronepicr | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) | [Commons](https://commons.wikimedia.org/wiki/File:Na_Pali_Coast_Kauai_Hawaii_(32406276598).jpg) |
| 10 | `denali.jpg` | Wonder Lake, Denali National Park, Alaska | NPS / Mary Lewandowski | [Public domain](https://www.nps.gov/aboutus/disclaimer.htm) | [Commons](https://commons.wikimedia.org/wiki/File:Wonder_Lake_View_(1a01b79f-2d27-44f5-86c0-7190ac168ea8).jpg) |

To add or replace a wallpaper, edit `tools/wallpapers.json` (any Commons file with a CC0/CC BY/CC BY-SA license) and run
`python3 tools/build-wallpapers.py`, or drop your own 3840×2160 JPEGs in `images/wallpapers/` and list them in `js/wallpapers.js`.
