/**
 * Northeastern hero cluster — factual massing data. GENERATED, do not hand-edit.
 *
 *   node tools/neu-hero/build.mjs
 *
 * Source: Boston Buildings with Roof Breaks — City of Boston (Boston Maps)
 * Licence: PDDL (odc-pddl) via data.boston.gov
 * Vintage: 2010 snapshot
 * Fields:  GRND_ELEV_2010 / ROOF_ELEV_2010 / BLDG_HGT_2010, US feet
 * Service: https://gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer/9
 *
 * Validated sub-metre against two towers whose heights are independently known:
 * Prudential 228 m against a true 228 m,
 * 111 Clarendon 240.2 m against a true 241 m.
 *
 * This layer SUPERSEDES the Boston 3D heights in docs/neu/HEIGHT_MEASUREMENTS.json,
 * which run a median +6.6 m high and imply
 * 4.9-5.9 m per storey on this quadrangle against this layer's 3.7-4.3.
 * **Do not reintroduce the ~24-25 m Krentzman values.**
 *
 * Outlines are CLOSED rings of [x, z] in world metres, already projected through
 * `Geo.geo()`, so no conversion happens at runtime. Heights are metres of the
 * part itself (ROOF_ELEV - GRND_ELEV), NOT metres above the game terrain.
 *
 * The unit here is the SOURCE PART, not the named building: 661061 is the
 * dominant mass of both Ell and Curry, 666437 a tier of both Richards and
 * Hayden, 676669 of both Dodge and Hastings. Rendering per building would
 * extrude those twice.
 */

/** Parts worth runtime geometry: 19 of 23, 643 ring vertices. */
export const NEU_HERO_PARTS = [
  {
    id: 661048, tier: 'PRIMARY', heightM: 11.61, areaM2: 7926,
    landUse: "E", gndElevM: 3.35,
    buildings: ["Cabot Center (& Barletta Natatorium)"],
    dominantOf: ["Cabot Center (& Barletta Natatorium)"],
    outline: [[-1974.46,1725.73], [-1969.35,1735.35], [-1965.27,1743.04], [-1957.13,1758.35], [-1954.63,1757.01], [-1952.29,1755.76], [-1947.3,1753.09], [-1940.37,1749.38], [-1933.57,1762.17], [-1932.13,1764.88], [-1932.13,1764.89], [-1935.27,1766.58], [-1933.61,1769.71], [-1926.76,1766.05], [-1910.41,1796.83], [-1918.35,1801.08], [-1919.64,1801.77], [-1939.17,1812.23], [-1940.57,1812.98], [-1948.47,1817.21], [-1950.29,1818.19], [-1955.24,1820.84], [-1956.61,1821.57], [-1966.98,1827.12], [-1967.06,1827.17], [-1967.22,1826.87], [-1972.11,1829.48], [-1972.48,1829.68], [-1972.01,1830.57], [-1999.28,1845.18], [-2010.74,1823.61], [-2012.17,1820.92], [-2013.61,1818.19], [-2014,1817.48], [-2018.63,1808.75], [-2019.08,1807.91], [-2014.63,1805.53], [-2018.1,1799], [-2021.09,1800.6], [-2022.12,1798.66], [-2025.94,1800.14], [-2028.36,1793.85], [-2028.56,1793.33], [-2027.82,1793.05], [-2022.36,1790.99], [-2025.83,1784.46], [-2026.51,1783.17], [-2014.76,1776.87], [-2013.22,1776.05], [-2016.39,1770.08], [-2018.06,1766.93], [-2018.17,1766.72], [-2025.53,1752.87], [-2025.93,1752.12], [-1974.95,1724.82], [-1974.46,1725.73]],
  },
  {
    id: 661061, tier: 'PRIMARY', heightM: 16, areaM2: 5970,
    landUse: "E", gndElevM: 2.44,
    buildings: ["Ell Hall","Curry Student Center"],
    dominantOf: ["Ell Hall","Curry Student Center"],
    outline: [[-1822.48,1727.04], [-1822.35,1727.3], [-1820.1,1731.52], [-1820.09,1731.53], [-1819.21,1733.18], [-1818.77,1734], [-1821.84,1735.65], [-1818.93,1741.11], [-1817.1,1744.52], [-1816.45,1745.75], [-1816.05,1746.5], [-1812.69,1752.79], [-1810.74,1756.44], [-1809.23,1759.26], [-1808.62,1760.4], [-1803.19,1770.57], [-1799.54,1777.41], [-1799.33,1777.79], [-1794.85,1775.37], [-1793.29,1778.29], [-1792.3,1777.76], [-1790.89,1780.39], [-1789.4,1783.18], [-1783.85,1793.56], [-1775.73,1808.78], [-1774.72,1810.65], [-1776.81,1811.78], [-1776.68,1812.01], [-1776.16,1812.98], [-1775.25,1812.49], [-1767.22,1827.53], [-1808.24,1849.62], [-1808.29,1849.65], [-1808.3,1849.63], [-1811.98,1842.74], [-1813.51,1839.88], [-1812.01,1839.07], [-1812.88,1837.42], [-1813.8,1837.92], [-1814.22,1837.14], [-1814.63,1837.36], [-1819.68,1840.08], [-1820.25,1840.39], [-1822.89,1835.46], [-1827.94,1838.18], [-1838.94,1817.59], [-1833.88,1814.87], [-1836.51,1809.95], [-1835.2,1809.24], [-1830.48,1806.7], [-1833.5,1801.06], [-1834.23,1799.68], [-1834.18,1799.65], [-1833.31,1799.19], [-1834.61,1796.76], [-1834.03,1796.45], [-1836.43,1791.97], [-1840.38,1784.58], [-1841.66,1782.18], [-1843.17,1779.35], [-1845.49,1775.01], [-1845.86,1774.32], [-1846.54,1773.04], [-1851.72,1763.34], [-1852.61,1761.68], [-1856.54,1754.32], [-1859.47,1755.9], [-1859.68,1756.02], [-1860.47,1754.54], [-1861.79,1752.07], [-1862.72,1750.33], [-1863.44,1748.97], [-1863.56,1748.76], [-1865.18,1745.72], [-1865.33,1745.43], [-1866.87,1742.56], [-1866.93,1742.45], [-1869.33,1737.96], [-1868.85,1737.7], [-1867.32,1736.87], [-1866.93,1736.67], [-1854.61,1730.03], [-1854.35,1729.89], [-1853.98,1729.69], [-1853.55,1729.46], [-1844.04,1724.34], [-1843.65,1724.13], [-1843.19,1723.89], [-1842.75,1723.64], [-1831.06,1717.35], [-1830.61,1717.11], [-1829.81,1716.68], [-1828.7,1716.08], [-1828.42,1715.93], [-1822.48,1727.04]],
  },
  {
    id: 660840, tier: 'PRIMARY', heightM: 18.74, areaM2: 2860,
    landUse: "E", gndElevM: 2.74,
    buildings: ["Dana Research Center"],
    dominantOf: ["Dana Research Center"],
    outline: [[-1895.49,1876.03], [-1889.3,1887.67], [-1888.58,1889.03], [-1888.5,1889.19], [-1886.43,1893.07], [-1886.31,1893.3], [-1883.51,1898.57], [-1880.96,1903.38], [-1879.86,1905.45], [-1881.85,1906.52], [-1885.18,1908.3], [-1900.58,1916.55], [-1900.9,1915.96], [-1902.1,1916.61], [-1907.16,1919.31], [-1908.34,1919.95], [-1908.06,1920.48], [-1918.68,1926.17], [-1921.04,1927.44], [-1922.06,1927.98], [-1922.34,1927.45], [-1923.38,1928.01], [-1923.27,1928.22], [-1949.82,1942.44], [-1949.43,1943.17], [-1953.45,1945.3], [-1953.83,1944.58], [-1959.5,1947.62], [-1965.44,1936.44], [-1967.71,1932.18], [-1973.59,1921.11], [-1968.85,1918.58], [-1965.55,1916.81], [-1964.96,1916.49], [-1940.02,1903.14], [-1937.43,1901.75], [-1937.35,1901.7], [-1936.55,1903.21], [-1935.52,1902.66], [-1937.69,1898.58], [-1931.41,1895.21], [-1921.45,1889.88], [-1919.04,1888.59], [-1918.87,1888.49], [-1918.28,1888.18], [-1895.51,1875.99], [-1895.49,1876.03]],
  },
  {
    id: 660748, tier: 'PRIMARY', heightM: 21.39, areaM2: 2578,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Egan Engineering/Science Research Center"],
    dominantOf: ["Egan Engineering/Science Research Center"],
    outline: [[-1876.31,1932.74], [-1874.91,1935.37], [-1874.14,1936.82], [-1869.35,1945.79], [-1870.91,1946.63], [-1871.42,1946.9], [-1875.26,1948.97], [-1871.93,1955.22], [-1876.01,1957.41], [-1876.28,1957.56], [-1879.15,1959.1], [-1884.68,1962.07], [-1887.65,1963.67], [-1889.71,1965.64], [-1898.15,1973.73], [-1902.52,1977.93], [-1925.04,1999.52], [-1926.01,2000.46], [-1924.75,2001.78], [-1928.12,2005.02], [-1931.78,2008.53], [-1932.52,2007.76], [-1933.43,2006.8], [-1934.06,2007.41], [-1934.84,2007.84], [-1935.6,2008.27], [-1936.38,2008.65], [-1937.2,2008.98], [-1938.03,2009.24], [-1938.8,2009.42], [-1938.88,2009.44], [-1939.74,2009.59], [-1940.61,2009.66], [-1941.49,2009.68], [-1942.36,2009.63], [-1943.23,2009.52], [-1944.08,2009.35], [-1944.92,2009.12], [-1945.75,2008.82], [-1946.55,2008.47], [-1947.32,2008.06], [-1948.06,2007.6], [-1948.77,2007.08], [-1949.44,2006.52], [-1950.06,2005.91], [-1950.65,2005.25], [-1951.18,2004.55], [-1951.66,2003.82], [-1952.09,2003.06], [-1952.46,2002.26], [-1952.77,2001.44], [-1953.03,2000.61], [-1953.22,1999.75], [-1953.35,1998.88], [-1953.42,1998.01], [-1953.43,1997.13], [-1953.37,1996.26], [-1953.25,1995.39], [-1953.07,1994.53], [-1952.83,1993.68], [-1952.53,1992.86], [-1952.17,1992.06], [-1951.76,1991.29], [-1951.29,1990.55], [-1950.77,1989.84], [-1950.2,1989.18], [-1951.77,1987.53], [-1952.05,1987.24], [-1945.01,1980.49], [-1944.34,1981.19], [-1943.8,1981.76], [-1903.06,1942.68], [-1901.22,1941.69], [-1899.44,1940.73], [-1900.27,1939.18], [-1900.84,1939.49], [-1901.27,1938.69], [-1901.23,1938.67], [-1901.02,1938.56], [-1889.45,1932.34], [-1889.35,1932.29], [-1888.9,1933.12], [-1889.32,1933.34], [-1888.51,1934.86], [-1884.13,1932.5], [-1881.66,1931.26], [-1879.82,1931.09], [-1877.98,1931.68], [-1876.31,1932.74]],
  },
  {
    id: 661113, tier: 'PRIMARY', heightM: 18.92, areaM2: 2545,
    landUse: "E", gndElevM: 2.74,
    buildings: ["Mugar Life Sciences Building"],
    dominantOf: ["Mugar Life Sciences Building"],
    outline: [[-1754.59,1689.67], [-1739.81,1717.54], [-1734.55,1727.47], [-1738.98,1729.84], [-1744.01,1732.52], [-1739.6,1740.84], [-1739.3,1741.39], [-1753.39,1748.91], [-1759.79,1752.33], [-1773.92,1759.88], [-1774.92,1757.99], [-1778.57,1751.11], [-1787.92,1756.1], [-1800.01,1733.29], [-1800.25,1732.84], [-1800.28,1732.78], [-1801.63,1730.23], [-1803.83,1726.08], [-1803.88,1725.99], [-1807.31,1719.51], [-1807.54,1719.09], [-1808.11,1718.01], [-1806.51,1717.15], [-1804.27,1715.95], [-1803.45,1715.52], [-1795.61,1711.33], [-1791.04,1708.89], [-1785.51,1719.34], [-1782.58,1717.77], [-1782.5,1717.93], [-1781.02,1720.73], [-1783.94,1722.29], [-1783.03,1724.01], [-1780.96,1727.92], [-1767.9,1720.95], [-1767.56,1720.76], [-1761.88,1717.73], [-1766,1709.96], [-1766.24,1709.51], [-1766.62,1708.79], [-1766.66,1708.71], [-1770.82,1700.86], [-1771.05,1700.44], [-1771.29,1699.98], [-1771.91,1698.8], [-1771.98,1698.68], [-1754.7,1689.45], [-1754.59,1689.67]],
  },
  {
    id: 666435, tier: 'PRIMARY', heightM: 18.54, areaM2: 2212,
    landUse: "E", gndElevM: 3.05,
    buildings: ["Hayden Hall"],
    dominantOf: ["Hayden Hall"],
    outline: [[-1851.33,1797.73], [-1849.73,1800.73], [-1845.63,1808.43], [-1877.64,1825.6], [-1878.18,1824.59], [-1878.32,1824.33], [-1887.51,1807.05], [-1889.45,1803.4], [-1894.62,1793.68], [-1894.76,1793.41], [-1894.82,1793.31], [-1905.06,1774.06], [-1905.33,1773.57], [-1906.24,1771.84], [-1904.85,1771.1], [-1875.21,1755.2], [-1874.24,1754.68], [-1874.21,1754.73], [-1873.52,1756.02], [-1872.4,1758.13], [-1851.33,1797.73]],
  },
  {
    id: 666436, tier: 'PRIMARY', heightM: 18.65, areaM2: 2055,
    landUse: "E", gndElevM: 2.44,
    buildings: ["Richards Hall"],
    dominantOf: ["Richards Hall"],
    outline: [[-1904.46,1689.74], [-1894.53,1708.4], [-1894.34,1708.75], [-1894.21,1709], [-1894.09,1709.24], [-1887.59,1721.44], [-1887.52,1721.57], [-1887.2,1722.19], [-1886.98,1722.6], [-1876.36,1742.55], [-1880.71,1744.88], [-1910.36,1760.75], [-1911.64,1761.43], [-1915.62,1753.95], [-1916.65,1752.02], [-1920.59,1744.62], [-1905.27,1736.41], [-1908.82,1729.73], [-1908.87,1729.64], [-1910.86,1725.91], [-1912.62,1722.6], [-1916.27,1715.75], [-1931.62,1723.98], [-1935.58,1716.54], [-1936.65,1714.52], [-1940.55,1707.19], [-1907.3,1689.35], [-1905.25,1688.26], [-1904.63,1689.42], [-1904.46,1689.74]],
  },
  {
    id: 677308, tier: 'PRIMARY', heightM: 27.83, areaM2: 1681,
    landUse: "RC", gndElevM: 2.13,
    buildings: ["Hastings Hall"],
    dominantOf: ["Hastings Hall"],
    outline: [[-1765.9,1627.73], [-1780.79,1635.59], [-1780.88,1635.64], [-1784.14,1629.24], [-1790.04,1632.27], [-1788.34,1635.62], [-1798.45,1640.8], [-1796.84,1643.97], [-1800.58,1645.94], [-1796.04,1654.63], [-1790.84,1651.89], [-1783.65,1665.56], [-1779.05,1674.18], [-1777.81,1676.51], [-1776.75,1678.5], [-1777.94,1679.14], [-1775.72,1683.3], [-1774.73,1682.77], [-1773.28,1685.5], [-1787.34,1693.06], [-1787.06,1693.58], [-1787.34,1693.74], [-1788.83,1694.54], [-1797.96,1677.44], [-1816.97,1641.8], [-1817.28,1641.21], [-1817.45,1640.9], [-1817.45,1640.89], [-1814.12,1639.09], [-1813.89,1638.97], [-1811.34,1637.6], [-1810.94,1637.38], [-1807.18,1635.36], [-1806.79,1635.15], [-1802.11,1632.64], [-1789.99,1626.12], [-1786.49,1624.24], [-1781.81,1621.73], [-1766.27,1613.37], [-1764.3,1612.31], [-1761.09,1610.58], [-1757.14,1608.46], [-1753.81,1606.67], [-1751.99,1605.7], [-1750.79,1605.05], [-1744.68,1616.52], [-1760.24,1624.74], [-1765.9,1627.73]],
  },
  {
    id: 665218, tier: 'PRIMARY', heightM: 17.3, areaM2: 1587,
    landUse: "E", gndElevM: 3.05,
    buildings: ["Ryder Hall"],
    dominantOf: ["Ryder Hall"],
    outline: [[-2073.63,2083.48], [-2074.72,2090.05], [-2041.86,2094.59], [-2040.76,2086.51], [-2018.27,2089.63], [-2017.97,2089.67], [-2021.04,2112.53], [-2021.26,2114.2], [-2021.33,2114.2], [-2024.25,2114.24], [-2027.24,2114.21], [-2030.23,2114.12], [-2033.22,2113.96], [-2036.2,2113.74], [-2038.29,2113.54], [-2039.18,2113.46], [-2039.58,2113.41], [-2042.15,2113.11], [-2045.11,2112.7], [-2053.16,2111.61], [-2054.53,2111.42], [-2060.63,2110.59], [-2094.46,2106.01], [-2092.84,2087.55], [-2081.54,2089.11], [-2080.72,2082.3], [-2073.63,2083.48]],
  },
  {
    id: 676668, tier: 'PRIMARY', heightM: 18.47, areaM2: 1523,
    landUse: "E", gndElevM: 3.35,
    buildings: ["Dodge Hall"],
    dominantOf: ["Dodge Hall"],
    outline: [[-1822.89,1666.07], [-1812.64,1686.21], [-1805.08,1682.33], [-1801.19,1689.63], [-1801,1689.99], [-1796,1699.37], [-1820.38,1712.47], [-1820.52,1712.54], [-1821.46,1710.79], [-1821.58,1710.55], [-1821.73,1710.27], [-1831.24,1692.43], [-1831.78,1691.41], [-1838.23,1679.32], [-1840.41,1675.23], [-1840.5,1675.06], [-1848.2,1660.61], [-1848.45,1660.14], [-1849.43,1658.31], [-1847.47,1657.26], [-1847.09,1657.05], [-1827.25,1646.4], [-1826.98,1646.25], [-1826.77,1646.14], [-1824.9,1645.14], [-1818.84,1656.51], [-1818.24,1657.63], [-1815.71,1662.39], [-1822.89,1666.07]],
  },
  {
    id: 661069, tier: 'PRIMARY', heightM: 19.57, areaM2: 1505,
    landUse: "E", gndElevM: 2.74,
    buildings: ["Hurtig Hall"],
    dominantOf: ["Hurtig Hall"],
    outline: [[-1673.62,1711.27], [-1658.97,1738.77], [-1667.76,1743.5], [-1667.99,1743.62], [-1673.12,1746.37], [-1673.14,1746.38], [-1675.12,1747.45], [-1677.39,1748.67], [-1690.04,1755.47], [-1694.49,1757.85], [-1694.87,1758.06], [-1701.47,1761.6], [-1705.07,1754.84], [-1707.71,1749.89], [-1709.7,1746.17], [-1716.14,1734.08], [-1699.58,1725.18], [-1698.18,1724.43], [-1673.66,1711.26], [-1673.64,1711.24], [-1673.62,1711.27]],
  },
  {
    id: 665219, tier: 'SECONDARY', heightM: 12.36, areaM2: 1437,
    landUse: "E", gndElevM: 3.35,
    buildings: ["Ryder Hall"],
    dominantOf: [],
    outline: [[-2089.32,2065.43], [-2089,2065.47], [-2053.68,2070.26], [-2049.73,2070.79], [-2046.19,2071.27], [-2021.82,2074.57], [-2022.06,2076.38], [-2021.17,2076.5], [-2021.04,2075.53], [-2019.34,2075.76], [-2017.62,2076], [-2018.1,2079.56], [-2016.94,2079.72], [-2018.27,2089.63], [-2040.76,2086.51], [-2041.86,2094.59], [-2074.72,2090.05], [-2073.63,2083.48], [-2080.72,2082.3], [-2081.54,2089.11], [-2092.84,2087.55], [-2090.87,2065.22], [-2089.32,2065.43]],
  },
  {
    id: 677273, tier: 'PRIMARY', heightM: 17.56, areaM2: 797,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Shillman Hall"],
    dominantOf: ["Shillman Hall"],
    outline: [[-2002.07,1974.73], [-2002.3,1976.06], [-2002.6,1977.39], [-2002.95,1978.69], [-2003.37,1979.98], [-2003.84,1981.25], [-2004.38,1982.5], [-2004.97,1983.71], [-2005.62,1984.9], [-2006.32,1986.06], [-2007.07,1987.18], [-2007.88,1988.27], [-2007.99,1988.41], [-2008.73,1989.32], [-2009.64,1990.33], [-2010.58,1991.29], [-2011.58,1992.21], [-2012.61,1993.08], [-2013.68,1993.9], [-2014.79,1994.67], [-2015.79,1995.29], [-2015.94,1995.39], [-2017.12,1996.05], [-2018.32,1996.66], [-2019.56,1997.21], [-2020.81,1997.7], [-2022.09,1998.14], [-2023.39,1998.51], [-2024.71,1998.82], [-2026.03,1999.07], [-2027.37,1999.26], [-2028.71,1999.38], [-2030.06,1999.44], [-2031.41,1999.44], [-2032.23,1999.4], [-2032.76,1999.37], [-2034.1,1999.24], [-2035.61,1999.13], [-2035.36,1995.86], [-2037.36,1995.73], [-2036.04,1978.75], [-2028.74,1979.25], [-2027.06,1977.68], [-2027.51,1977.2], [-2027.45,1975.22], [-2026.09,1973.95], [-2023.98,1974.14], [-2023.44,1974.73], [-2021.71,1973.12], [-2021.1,1965.95], [-2004.27,1967.28], [-2004.4,1969], [-2001.37,1969.17], [-2001.49,1970.76], [-2001.67,1972.15], [-2001.72,1972.5], [-2001.88,1973.57], [-2002.07,1974.73]],
  },
  {
    id: 666437, tier: 'SECONDARY', heightM: 2.21, areaM2: 394,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Richards Hall","Hayden Hall"],
    dominantOf: [],
    outline: [[-1879.14,1747.82], [-1876.54,1752.71], [-1875.25,1755.13], [-1875.21,1755.2], [-1904.85,1771.1], [-1906.33,1768.32], [-1908.76,1763.76], [-1910.36,1760.75], [-1880.71,1744.88], [-1879.14,1747.82]],
  },
  {
    id: 677274, tier: 'SECONDARY', heightM: 13.39, areaM2: 196,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Shillman Hall"],
    dominantOf: [],
    outline: [[-2003.2,1955.7], [-2003.63,1962.31], [-2003.88,1962.29], [-2004.27,1967.28], [-2021.1,1965.95], [-2020.86,1963.05], [-2020.3,1954.57], [-2003.2,1955.7]],
  },
  {
    id: 676669, tier: 'SECONDARY', heightM: 8.15, areaM2: 187,
    landUse: "E", gndElevM: 2.44,
    buildings: ["Dodge Hall","Hastings Hall"],
    dominantOf: [],
    outline: [[-1805.08,1682.33], [-1812.64,1686.21], [-1822.89,1666.07], [-1815.71,1662.39], [-1805.08,1682.33]],
  },
  {
    id: 677276, tier: 'SECONDARY', heightM: 13.39, areaM2: 185,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Shillman Hall"],
    dominantOf: [],
    outline: [[-2036.04,1978.75], [-2037.36,1995.73], [-2042.09,1995.41], [-2048.1,1995.02], [-2046.98,1978.02], [-2038.86,1978.56], [-2036.04,1978.75]],
  },
  {
    id: 677277, tier: 'SECONDARY', heightM: 4.58, areaM2: 172,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Shillman Hall"],
    dominantOf: [],
    outline: [[-2021.71,1973.12], [-2023.44,1974.73], [-2023.98,1974.14], [-2026.09,1973.95], [-2027.45,1975.22], [-2027.51,1977.2], [-2027.06,1977.68], [-2028.74,1979.25], [-2036.04,1978.75], [-2038.86,1978.56], [-2038.59,1974.51], [-2025.28,1962.76], [-2022.68,1962.93], [-2020.86,1963.05], [-2021.71,1973.12]],
  },
  {
    id: 676716, tier: 'SECONDARY', heightM: 7.25, areaM2: 133,
    landUse: "RC", gndElevM: 1.52,
    buildings: ["Hastings Hall"],
    dominantOf: [],
    outline: [[-1778.38,1662.73], [-1783.65,1665.56], [-1790.84,1651.89], [-1794.24,1645.41], [-1789.28,1642.68], [-1778.38,1662.73]],
  },
];

/**
 * Recorded but deliberately NOT rendered — under 100 m2 of roof break.
 * Note 677278 and 677275: these two
 * carry Shillman's headline 19.6 m on 22 m2 and 20 m2 of plan,
 * so the rendered mass tops out at its dominant part's 17.56 m instead. That is
 * the intended trade: structural silhouette over completeness.
 */
export const NEU_HERO_MICRO = [
  {
    id: 677310, tier: 'MICRO', heightM: 21.52, areaM2: 53,
    landUse: "RC", gndElevM: 1.52,
    buildings: ["Hastings Hall"],
    dominantOf: [],
    outline: [[-1796.84,1643.97], [-1795.67,1646.2], [-1794.24,1645.41], [-1790.84,1651.89], [-1796.04,1654.63], [-1800.58,1645.94], [-1796.84,1643.97]],
  },
  {
    id: 662045, tier: 'MICRO', heightM: 11.61, areaM2: 24,
    landUse: "E", gndElevM: 3.35,
    buildings: ["Cabot Center (& Barletta Natatorium)"],
    dominantOf: [],
    outline: [[-2000.45,1844.63], [-2001.65,1845.26], [-2003.84,1846.41], [-2005.36,1843.51], [-2006.76,1840.84], [-2003.37,1839.05], [-2000.45,1844.63]],
  },
  {
    id: 677278, tier: 'MICRO', heightM: 19.6, areaM2: 22,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Shillman Hall"],
    dominantOf: [],
    outline: [[-2035.36,1995.86], [-2035.61,1999.13], [-2042.3,1998.6], [-2042.09,1995.41], [-2035.36,1995.86]],
  },
  {
    id: 677275, tier: 'MICRO', heightM: 19.6, areaM2: 20,
    landUse: "E", gndElevM: 3.66,
    buildings: ["Shillman Hall"],
    dominantOf: [],
    outline: [[-2000.89,1962.49], [-2001.37,1969.17], [-2004.4,1969], [-2004.27,1967.28], [-2003.88,1962.29], [-2003.63,1962.31], [-2000.89,1962.49]],
  },
];

/** Named buildings and the parts they claim. Evidence, not geometry. */
export const NEU_HERO_BUILDINGS = [
  {
    name: "Ell Hall", status: 'COMPLEX',
    headlineHeightM: 16, dominantPart: 661061,
    dominantHeightM: 16,
    parts: [661061],
    sourceFootprintM2: 5970, officialFootprintM2: 2864,
    yearBuilt: 1947,
    storeys: 4, courseM: 4, storeyConfidence: 'DERIVED',
    storeyBasis: "dominant mass / 3.8 m; gross-area implication was 2.9",
    statusWhy: "parts sum to 5970 m2 against an official 2864 m2 (x2.08) — the radius includes a neighbour",
  },
  {
    name: "Richards Hall", status: 'CONFIRMED',
    headlineHeightM: 18.65, dominantPart: 666436,
    dominantHeightM: 18.65,
    parts: [666436, 666437],
    sourceFootprintM2: 2449, officialFootprintM2: 2354,
    yearBuilt: 1938,
    storeys: 5, courseM: 3.73, storeyConfidence: 'C',
    storeyBasis: "OSM levels, corroborated by the factual height",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Hayden Hall", status: 'CONFIRMED',
    headlineHeightM: 18.54, dominantPart: 666435,
    dominantHeightM: 18.54,
    parts: [666435, 666437],
    sourceFootprintM2: 2606, officialFootprintM2: 2307,
    yearBuilt: 1956,
    storeys: 5, courseM: 3.71, storeyConfidence: 'C',
    storeyBasis: "OSM levels, corroborated by the factual height",
    statusWhy: "footprint agrees to x1.13",
  },
  {
    name: "Dodge Hall", status: 'CONFIRMED',
    headlineHeightM: 18.47, dominantPart: 676668,
    dominantHeightM: 18.47,
    parts: [676668, 676669],
    sourceFootprintM2: 1710, officialFootprintM2: 1697,
    yearBuilt: 1952,
    storeys: 5, courseM: 3.69, storeyConfidence: 'C',
    storeyBasis: "OSM levels, corroborated by the factual height",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Curry Student Center", status: 'COMPLEX',
    headlineHeightM: 16, dominantPart: 661061,
    dominantHeightM: 16,
    parts: [661061],
    sourceFootprintM2: 5970, officialFootprintM2: 3271,
    yearBuilt: 1964,
    storeys: 4, courseM: 4, storeyConfidence: 'DERIVED',
    storeyBasis: "dominant mass / 3.8 m; gross-area implication was 4.8",
    statusWhy: "parts sum to 5970 m2 against an official 3271 m2 (x1.83) — the radius includes a neighbour",
  },
  {
    name: "Cabot Center (& Barletta Natatorium)", status: 'CONFIRMED',
    headlineHeightM: 11.61, dominantPart: 661048,
    dominantHeightM: 11.61,
    parts: [661048, 662045],
    sourceFootprintM2: 7950, officialFootprintM2: 7851,
    yearBuilt: 1954,
    storeys: 3, courseM: 3.87, storeyConfidence: 'DERIVED',
    storeyBasis: "dominant mass / 3.8 m; gross-area implication was 3",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Mugar Life Sciences Building", status: 'CONFIRMED',
    headlineHeightM: 18.92, dominantPart: 661113,
    dominantHeightM: 18.92,
    parts: [661113],
    sourceFootprintM2: 2545, officialFootprintM2: 2568,
    yearBuilt: 1941,
    storeys: 5, courseM: 3.78, storeyConfidence: 'C',
    storeyBasis: "OSM levels, corroborated by the factual height",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Ryder Hall", status: 'CONFIRMED',
    headlineHeightM: 17.3, dominantPart: 665218,
    dominantHeightM: 17.3,
    parts: [665218, 665219],
    sourceFootprintM2: 3024, officialFootprintM2: 3024,
    yearBuilt: 1913,
    storeys: 4, courseM: 4.33, storeyConfidence: 'C',
    storeyBasis: "OSM levels, corroborated by the factual height",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Egan Engineering/Science Research Center", status: 'CONFIRMED',
    headlineHeightM: 21.39, dominantPart: 660748,
    dominantHeightM: 21.39,
    parts: [660748],
    sourceFootprintM2: 2578, officialFootprintM2: 2587,
    yearBuilt: 1996,
    storeys: 6, courseM: 3.56, storeyConfidence: 'DERIVED',
    storeyBasis: "dominant mass / 3.8 m; gross-area implication was 4.2",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Shillman Hall", status: 'CONFIRMED',
    headlineHeightM: 19.6, dominantPart: 677273,
    dominantHeightM: 17.56,
    parts: [677278, 677275, 677273, 677274, 677276, 677277],
    sourceFootprintM2: 1392, officialFootprintM2: 1409,
    yearBuilt: 1995,
    storeys: 5, courseM: 3.51, storeyConfidence: 'DERIVED',
    storeyBasis: "dominant mass / 3.8 m; gross-area implication was 3.3",
    statusWhy: "footprint agrees to within 10%",
  },
  {
    name: "Hastings Hall", status: 'COMPLEX',
    headlineHeightM: 27.83, dominantPart: 677308,
    dominantHeightM: 27.83,
    parts: [677308, 677310, 676669, 676716],
    sourceFootprintM2: 2054, officialFootprintM2: 1046,
    yearBuilt: 1913,
    storeys: 7, courseM: 3.98, storeyConfidence: 'D',
    storeyBasis: "assessor storey count in HERO_FOOTPRINTS.targetedValidation",
    statusWhy: "parts sum to 2054 m2 against an official 1046 m2 (x1.96) — the radius includes a neighbour",
  },
  {
    name: "Dana Research Center", status: 'COMPLEX',
    headlineHeightM: 18.74, dominantPart: 660840,
    dominantHeightM: 18.74,
    parts: [660840],
    sourceFootprintM2: 2860, officialFootprintM2: 1244,
    yearBuilt: 1966,
    storeys: 5, courseM: 3.75, storeyConfidence: 'C',
    storeyBasis: "OSM levels, corroborated by the factual height",
    statusWhy: "parts sum to 2860 m2 against an official 1244 m2 (x2.30) — the radius includes a neighbour",
  },
  {
    name: "Hurtig Hall", status: 'CONFIRMED',
    headlineHeightM: 19.57, dominantPart: 661069,
    dominantHeightM: 19.57,
    parts: [661069],
    sourceFootprintM2: 1505, officialFootprintM2: 1519,
    yearBuilt: 1968,
    storeys: 5, courseM: 3.91, storeyConfidence: 'DERIVED',
    storeyBasis: "dominant mass / 3.8 m; gross-area implication was 5",
    statusWhy: "footprint agrees to within 10%",
  },
];

export const NEU_HERO_SOURCE = {
  dataset: "Boston Buildings with Roof Breaks",
  publisher: "City of Boston (Boston Maps)",
  licence: "PDDL (odc-pddl) via data.boston.gov",
  vintage: "2010 snapshot",
  service: "https://gis.bostonplans.org/hosting/rest/services/Boston_Buildings/FeatureServer/9",
  microThresholdM2: 100,
};
