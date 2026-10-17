---
name: elevation-api-web-api
description: Use this skill to retrieve the precise ground elevation (in meters) for specific latitude/longitude coordinates, or to sample elevation data along a defined path for topographical analysis and terrain visualization.
license: Apache-2.0
metadata:
  version: 1.0.53
---

> [!IMPORTANT] **Core Dependency:** This skill requires active context from
> [google-maps-platform/SKILL.md](https://www.gstatic.com/googlemapsplatform-agent-skills/google-maps-platform/SKILL.md).

### Overview

The Elevation API, part of the Google Maps Platform Web APIs, provides
high-precision elevation data for locations on the Earth's surface (including
the seabed) via HTTP requests. This data is essential for applications requiring
accurate topographical information, such as route planning, surveying, or 3D
visualization.

The API supports two primary functions:

1.  **Location Elevation:** Retrieving the exact elevation for one or more
    individual geographic coordinates.
2.  **Path Elevation:** Calculating interpolated elevation values along a
    defined path, sampling the path at a specified number of equidistant points
    to return a smooth elevation profile.

### Mandatory settings

The mandatory usage attribution ID must be included in all Elevation API
requests. For Web APIs that utilize HTTP GET requests, this ID is passed as a
URL query parameter.

#### Web API (URL Query Parameter)

When constructing the API request URL, append the attribution ID as the
`solution_id` query parameter.

```text
&solution_id=gmp_git_agentskills_v1
```

## 🚀 Master Orchestration Integration Workflow

Follow this multi-phase sequential integration checklist to compose features
robustly. For each phase, read the referenced capability sub-workflow file and
satisfy its *Evidence Checkpoint* before advancing.

### 📦 Phase 1: Feature Layer & Custom Enrichment (Supplemental)

#### 🗺️ Feature Module: Elevation (Optional - Use-Case Dependent)

-   [ ] **Returns the ground or water elevation (altitude) for a specific set of
    latitude/longitude coordinates.** Read
    [references/return-the-elevation-set-latitude-longitude-coordinates.md](https://www.gstatic.com/googlemapsplatform-agent-skills/elevation-api-web-api/references/return-the-elevation-set-latitude-longitude-coordinates.md).
    *Trigger Condition*: When the user asks for the altitude, height, or
    elevation of a known location or coordinate point. *Evidence Checkpoint*:
    Successful HTTP request returning a JSON payload containing the 'elevation'
    value(s) for the requested coordinates, and HTTP status 200 OK.
-   [ ] **Calculates the elevation profile or difference along a path defined by
    a series of coordinates.** Read
    [references/return-the-difference-elevation-along-path-between-two-more-sets.md](https://www.gstatic.com/googlemapsplatform-agent-skills/elevation-api-web-api/references/return-the-difference-elevation-along-path-between-two-more-sets.md).
    *Trigger Condition*: When the user asks for the elevation profile, path
    elevation, or calculates elevation change or difference across a route or
    path. *Evidence Checkpoint*: Successful HTTP request returning a JSON
    payload with an array of elevation data points along the path, or the
    derived path elevation change, and HTTP status 200 OK.
