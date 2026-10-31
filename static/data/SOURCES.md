# Example data

The examples and test pages read these datasets from `static/data/`. They are not part of this repository or of the Fjäder packages: `npm run fetch-data` downloads each file from the upstream repository that publishes it, pinned to a commit and checked by SHA-256 (see `scripts/fetch-data.js`).

Thanks to [Observable Plot](https://github.com/observablehq/plot/tree/main/test/data) and [Mosaic](https://github.com/uwdata/mosaic/tree/main/data), whose curated copies these are. The original sources and their terms are below, as the upstream projects record them ([Plot's data notes](https://github.com/observablehq/plot/blob/main/test/data/README.md), [vega-datasets' metadata](https://github.com/vega/vega-datasets/blob/main/datapackage.json)).

## U.S. government data (public domain)

| File                                | Upstream copy   | Original source                                                                                                                                                                                            |
| ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bls-industry-unemployment.csv`     | Observable Plot | U.S. Bureau of Labor Statistics and Census Bureau, Current Population Survey. Plot does not note a source; the rows are identical to vega-datasets' `unemployment-across-industries`, which credits these. |
| `flights-200k.parquet`              | Mosaic          | U.S. Bureau of Transportation Statistics, on-time performance. vega-datasets notes the terms are not stated explicitly.                                                                                    |
| `gistemp.csv`                       | Observable Plot | NASA Goddard Institute for Space Studies, [GISTEMP](https://data.giss.nasa.gov/gistemp/)                                                                                                                   |
| `seattle-weather.parquet`           | Mosaic          | NOAA National Climatic Data Center                                                                                                                                                                         |
| `sf-temperatures.csv`               | Observable Plot | NOAA National Climatic Data Center                                                                                                                                                                         |
| `travelers.parquet`                 | Mosaic          | TSA, [checkpoint passenger throughput](https://www.tsa.gov/coronavirus/passenger-throughput)                                                                                                               |
| `us-state-population-2010-2019.csv` | Observable Plot | U.S. Census Bureau. Plot marks the source as uncertain.                                                                                                                                                    |

## Openly licensed

| File               | Upstream copy   | Original source                                                                                                      | License       |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------- | ------------- |
| `diamonds.csv`     | Observable Plot | ggplot2's `diamonds` dataset, carat and price columns only                                                           | MIT (ggplot2) |
| `penguins.parquet` | Mosaic          | Palmer Station Antarctica LTER, via [Allison Horst's palmerpenguins](https://github.com/allisonhorst/palmerpenguins) | CC0-1.0       |

## Terms not stated upstream

These are widely used in visualization examples, but neither upstream states a license for them. Prefer the datasets above for anything published, such as a demo site.

| File                | Upstream copy                       | Original source                                                                                     |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `aapl.csv`          | Observable Plot                     | Yahoo! Finance, Apple stock prices                                                                  |
| `alphabet.csv`      | Observable Plot                     | Letter frequencies from _Cryptographical Mathematics_ by Robert Edward Lewand                       |
| `cars.csv`          | Observable Plot                     | 1983 ASA Data Exposition, [StatLib](http://lib.stat.cmu.edu/datasets/)                              |
| `civilizations.csv` | Observable Plot                     | Unknown                                                                                             |
| `driving.csv`       | Observable Plot                     | Based on Hannah Fairfield's _Driving Shifts Into Reverse_, The New York Times, 2010                 |
| `olympians.csv`     | Observable Plot (as `athletes.csv`) | Matt Riggott, from IOC data ([Olympic Games data](https://www.flother.is/2017/olympic-games-data/)) |
