# Gallery download worker

A small Cloudflare Worker that serves the Hypen Gallery mobile builds out of R2 with stable URLs:

```
/android/latest        → newest hypen-gallery-*.apk
/android/v-1-22-3      → a specific version
/ios/latest            → newest hypen-gallery-*.zip (Simulator build)
/ios/v-1-22-3
```

`scripts/publish-gallery.sh` uploads the builds and prints these URLs. The directory keeps the auto-generated Worker name (`red-water-3890`) because that is the deployed Worker's name on Cloudflare; renaming the directory would not rename the Worker.
