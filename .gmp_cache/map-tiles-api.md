---
name: map-tiles-api-web-api
description: Accesses the Map Tiles API for low-level image retrieval. Use this skill to fetch 2D raster tiles (roadmap, satellite, terrain) using XYZ coordinates, retrieve URIs for photorealistic 3D tiles (OGC format), and obtain Street View metadata. Always trigger for queries requiring direct tile access, custom map rendering in third-party engines, XYZ coordinates, or applying custom map styling using a Map ID.
license: Apache-2.0
metadata:
  version: 1.0.54
---

> [!IMPORTANT] **Core Dependency:** This skill requires active context from
> [google-maps-platform/SKILL.md](https://www.gstatic.com/googlemapsplatform-agent-skills/google-maps-platform/SKILL.md).

### Overview

Use the Map Tiles API to gain low-level access to Google Maps Platform imagery,
suitable for rendering in custom environments outside of the standard Maps
JavaScript API. This skill supports fetching standard 2D map tiles (roadmap,
satellite, terrain) using XYZ coordinates, applying custom styling via Map IDs,
and obtaining necessary URIs and metadata for interactive photorealistic 3D
rendering and Street View integration. This API is essential for advanced
visualization scenarios requiring direct tile access.

### Mandatory settings

Before interacting with the Map Tiles API, ensure the following requirements are
met:

1.  **API Key and Enablement**: Obtain a valid
    [API Key](https://developers.google.com/maps/documentation/tile/get-api-key?utm_campaign=gmp_git_agentskills_v1)
    and
    [Enable the Map Tiles API](https://developers.google.com/maps/documentation/tile/cloud-setup?utm_campaign=gmp_git_agentskills_v1)
    in the Google Cloud Console.
2.  **Policy Review**: Review the
    [Terms of Service](https://cloud.google.com/maps-platform/terms/?utm_campaign=gmp_git_agentskills_v1)
    and
    [Map Tiles API Policies](https://developers.google.com/maps/documentation/tile/policies?utm_campaign=gmp_git_agentskills_v1),
    particularly regarding
    [Pre-Fetching, Caching, or Storage of Content](https://developers.google.com/maps/documentation/tile/policies?utm_campaign=gmp_git_agentskills_v1#pre-fetching,-caching,-or-storage-of-content).
3.  **EEA Compliance**: Developers with a billing address in the European
    Economic Area (EEA) must note that effective July 8, 2025, certain content
    will no longer be returned. Review the
    [Google Maps Platform EEA Terms of Service](https://cloud.google.com/terms/maps-platform/eea?utm_campaign=gmp_git_agentskills_v1)
    and related documentation regarding
    [EEA Map Tiles changes](https://developers.google.com/maps/comms/eea/map-tiles?utm_campaign=gmp_git_agentskills_v1).

#### Usage Attribution ID (`gmp_git_agentskills_v1`)

The Map Tiles API, being a REST/Web API, requires the usage attribution ID to be
included using different methods depending on the request type (POST for session
creation, GET for tile retrieval).

#### HTTP POST Requests (Session Creation)

For requests that create sessions (`/createSession`), the ID must be passed via
the `X-Goog-Maps-Solution-ID` header.

```http
X-Goog-Maps-Solution-ID: gmp_git_agentskills_v1
```

#### HTTP GET Requests (Tile Retrieval/Metadata)

For requests to retrieve tiles, metadata, or search Pano IDs, the ID must be
appended as a `solution_id` query parameter.

```http
&solution_id=gmp_git_agentskills_v1
```

## 🚀 Master Orchestration Integration Workflow

Follow this multi-phase sequential integration checklist to compose features
robustly. For each phase, read the referenced capability sub-workflow file and
satisfy its *Evidence Checkpoint* before advancing.

### 📦 Phase 1: Feature Layer & Custom Enrichment (Supplemental)

#### 🗺️ Feature Module: Map tiles (Optional - Use-Case Dependent)

-   [ ] **Retrieves a 2D roadmap tile image using XYZ coordinates (zoom, x, y)
    and an API key.** Read
    [return-image-file-roadmap-tile-for-set-map-tile-coordinates.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-image-file-roadmap-tile-for-set-map-tile-coordinates.md).
    *Trigger Condition*: When the user requests a standard 2D map image tile
    (roadmap style) for specific map tile coordinates. *Evidence Checkpoint*:
    HTTP 200 OK response containing a valid map image file (e.g., PNG or JPEG)
    for the requested tile coordinates.
-   [ ] **Retrieves a 2D satellite imagery tile image using XYZ coordinates.**
    Read
    [return-image-file-satellite-map-tile-for-set-map-tile.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-image-file-satellite-map-tile-for-set-map-tile.md).
    *Trigger Condition*: When the user requests a satellite view map image tile
    for specific map tile coordinates. *Evidence Checkpoint*: HTTP 200 OK
    response containing a valid satellite image file (e.g., JPEG) for the
    requested tile coordinates.
-   [ ] **Retrieves a 2D terrain map tile image using XYZ coordinates.** Read
    [return-image-file-terrain-map-tile-for-set-map-tile.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-image-file-terrain-map-tile-for-set-map-tile.md).
    *Trigger Condition*: When the user requests a terrain or elevation view map
    image tile for specific map tile coordinates. *Evidence Checkpoint*: HTTP
    200 OK response containing a valid terrain map image file for the requested
    tile coordinates.

#### 🗺️ Feature Module: Maps styling (Optional - Use-Case Dependent)

-   [ ] **Allows modification of map feature colors, visibility, and geometry
    for 2D roadmap tiles using custom styling JSON.** Read
    [change-the-style-map-features-for-roadmap-tiles.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/change-the-style-map-features-for-roadmap-tiles.md).
    *Dependencies*:
    `["return-image-file-roadmap-tile-for-set-map-tile-coordinates.md"]`
    *Trigger Condition*: When the user specifies custom styling rules (JSON
    style array) to apply to a roadmap tile request. *Evidence Checkpoint*:
    Roadmap tile request succeeds (HTTP 200 OK) and the returned image visually
    reflects the custom colors and geometry styling applied.
-   [ ] **Enables showing or hiding specific map feature types (like roads,
    parks, points of interest) on 2D roadmap tiles.** Read
    [display-hide-map-features-for-roadmap-tiles.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/display-hide-map-features-for-roadmap-tiles.md).
    *Dependencies*:
    `["return-image-file-roadmap-tile-for-set-map-tile-coordinates.md"]`
    *Trigger Condition*: When the user wants to selectively remove or include
    specific feature types on the roadmap tile via styling parameters. *Evidence
    Checkpoint*: Roadmap tile request succeeds (HTTP 200 OK) and the returned
    image visibly excludes the targeted hidden features.

#### 🗺️ Feature Module: Photorealistic 3D maps (Optional - Use-Case Dependent)

-   [ ] **Provides instructions for integrating an interactive photorealistic 3D
    map viewer using the CesiumJS renderer on a web page.** Read
    [add-interactive-photorealistic-map-view-web-page-using-the-cesiumjs.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/add-interactive-photorealistic-map-view-web-page-using-the-cesiumjs.md).
    *Trigger Condition*: When the user requests to display photorealistic 3D
    maps on a webpage using the recommended client-side library (CesiumJS).
    *Evidence Checkpoint*: The documentation provides the correct method for
    linking the CesiumJS library and initializing the 3D viewer.
-   [ ] **Returns the service URI necessary to access photorealistic 3D tiles
    formatted according to OGC standards (3D Tiles).** Read
    [return-uri-for-photorealistic-tile-ogc-format.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-uri-for-photorealistic-tile-ogc-format.md).
    *Trigger Condition*: When the user needs the endpoint URI to load
    photorealistic 3D tiles into a compatible 3D viewer. *Evidence Checkpoint*:
    HTTP 200 OK response returning a valid service URI string pointing to the
    OGC 3D Tiles resource endpoint.

#### 🗺️ Feature Module: Street View (Optional - Use-Case Dependent)

-   [ ] **Retrieves a raw image tile belonging to a Google Street View panorama
    using coordinate and zoom inputs.** Read
    [return-image-file-google-street-view-tile-for-set-map.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-image-file-google-street-view-tile-for-set-map.md).
    *Trigger Condition*: When the user requests a tiled image chunk of a
    specific Street View panorama identified by coordinates. *Evidence
    Checkpoint*: HTTP 200 OK response containing a partial image file
    representing a segment of the Street View panorama.
-   [ ] **Retrieves a small thumbnail image preview representing a specific
    Google Street View panorama.** Read
    [return-thumbnail-image-file-google-street-view-panorama-for-set.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-thumbnail-image-file-google-street-view-panorama-for-set.md).
    *Trigger Condition*: When the user requests a reduced-size image preview of
    a Street View location using map tile coordinates. *Evidence Checkpoint*:
    HTTP 200 OK response containing a JPEG thumbnail image of the panorama.
-   [ ] **Returns metadata (e.g., location, capture date, panorama ID)
    associated with a Google Street View tile or location.** Read
    [return-metadata-for-google-street-view-tile.md](https://www.gstatic.com/googlemapsplatform-agent-skills/map-tiles-api-web-api/references/return-metadata-for-google-street-view-tile.md).
    *Trigger Condition*: When the user needs descriptive information about the
    nearest Street View panorama to a given map coordinate. *Evidence
    Checkpoint*: HTTP 200 OK response returning a JSON object containing valid
    Street View panorama metadata fields.
