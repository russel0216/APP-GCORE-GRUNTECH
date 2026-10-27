jsQR 1.4.0, Apache-2.0, from https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz
integrity sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==
Vendored (not an npm dependency) for the Marketing badge scanner: lib/qrScan.ts loads it with a <script> tag when the scanner opens, where the browser has no BarcodeDetector (iPhone Safari).
