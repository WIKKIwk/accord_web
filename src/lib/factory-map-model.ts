/** Physical aliases declared by the user-supplied zavod6-cad-line-art.glb.
 * Read from node.extras.factory_map_object_id / factory_map_aliases, not inferred
 * from apparatus names. Keep this manifest paired with the shipped model.
 */
export interface FactoryModelObject {
  objectId: string
  label: string
  aliases: readonly string[]
}
export const factoryModelSourceSha256 = "bf2ae9ccfec113818fa04e8b09f0825f271511132d9cf5b1dc6aeee83f0e6a2f"
export const factoryModelObjects = [
  {
    "objectId": "node:1:instance:0",
    "label": "7 ta rangli bosma aparat",
    "aliases": [
      "node:1:instance:0",
      "node:1:instance:1",
      "node:1:instance:2",
      "node:1:instance:3",
      "node:1:instance:4",
      "node:1:instance:5",
      "node:1:instance:6",
      "node:1:instance:7"
    ]
  },
  {
    "objectId": "node:18:instance:3",
    "label": "8 ta rangli bosma aparat",
    "aliases": [
      "node:18:instance:3",
      "node:18:instance:10",
      "node:18:instance:17",
      "node:18:instance:24"
    ]
  },
  {
    "objectId": "node:3:instance:0",
    "label": "9 ta rangli bosma aparat",
    "aliases": [
      "node:3:instance:0",
      "node:3:instance:1",
      "node:3:instance:2",
      "node:3:instance:3",
      "node:3:instance:4",
      "node:3:instance:5",
      "node:3:instance:6",
      "node:3:instance:7"
    ]
  },
  {
    "objectId": "node:6:instance:6",
    "label": "Laminatsiya 2",
    "aliases": [
      "node:6:instance:0",
      "node:6:instance:2",
      "node:6:instance:4",
      "node:6:instance:6",
      "node:6:instance:8",
      "node:6:instance:10",
      "node:6:instance:12",
      "node:6:instance:14",
      "node:4:instance:0",
      "node:4:instance:2",
      "node:4:instance:4",
      "node:4:instance:6",
      "node:4:instance:8",
      "node:4:instance:10",
      "node:4:instance:12",
      "node:4:instance:14"
    ]
  },
  {
    "objectId": "node:6:instance:7",
    "label": "Laminatsiya 1",
    "aliases": [
      "node:6:instance:1",
      "node:6:instance:3",
      "node:6:instance:5",
      "node:6:instance:7",
      "node:6:instance:9",
      "node:6:instance:11",
      "node:6:instance:13",
      "node:6:instance:15",
      "node:4:instance:1",
      "node:4:instance:3",
      "node:4:instance:5",
      "node:4:instance:7",
      "node:4:instance:9",
      "node:4:instance:11",
      "node:4:instance:13",
      "node:4:instance:15"
    ]
  },
  {
    "objectId": "node:18:instance:0",
    "label": "Flexo pechat",
    "aliases": [
      "node:18:instance:0",
      "node:18:instance:4",
      "node:18:instance:7",
      "node:18:instance:11",
      "node:18:instance:14",
      "node:18:instance:18",
      "node:18:instance:21",
      "node:18:instance:25"
    ]
  },
  {
    "objectId": "node:18:instance:2",
    "label": "Holodniy kley aparat",
    "aliases": [
      "node:18:instance:2",
      "node:18:instance:6",
      "node:18:instance:9",
      "node:18:instance:13",
      "node:18:instance:16",
      "node:18:instance:20",
      "node:18:instance:23",
      "node:18:instance:27"
    ]
  },
  {
    "objectId": "node:7",
    "label": "Extruder laminatsiya",
    "aliases": [
      "node:7:instance:0",
      "node:7:instance:1",
      "node:7:instance:2",
      "node:7:instance:3",
      "node:7:instance:4",
      "node:7:instance:5",
      "node:7:instance:6",
      "node:7:instance:7"
    ]
  },
  {
    "objectId": "node:20",
    "label": "Rezka 1",
    "aliases": [
      "node:20:instance:0",
      "node:20:instance:1",
      "node:20:instance:2",
      "node:20:instance:3",
      "node:20:instance:4",
      "node:20:instance:5",
      "node:20:instance:6",
      "node:20:instance:7"
    ]
  },
  {
    "objectId": "node:18:instance:1",
    "label": "Rezka 2",
    "aliases": [
      "node:18:instance:1",
      "node:18:instance:5",
      "node:18:instance:8",
      "node:18:instance:12",
      "node:18:instance:15",
      "node:18:instance:19",
      "node:18:instance:22",
      "node:18:instance:26"
    ]
  },
  {
    "objectId": "node:19:instance:1",
    "label": "Rezka 3",
    "aliases": [
      "node:19:instance:1",
      "node:19:instance:3",
      "node:19:instance:5",
      "node:19:instance:7",
      "node:19:instance:9",
      "node:19:instance:11",
      "node:19:instance:13",
      "node:19:instance:15"
    ]
  },
  {
    "objectId": "node:19:instance:0",
    "label": "Rezka 4",
    "aliases": [
      "node:19:instance:0",
      "node:19:instance:2",
      "node:19:instance:4",
      "node:19:instance:6",
      "node:19:instance:8",
      "node:19:instance:10",
      "node:19:instance:12",
      "node:19:instance:14"
    ]
  },
  {
    "objectId": "equipment:rezka:5",
    "label": "Rezka 5",
    "aliases": []
  }
] as const satisfies readonly FactoryModelObject[]

export const factoryModelObjectAliases: ReadonlyMap<string, string> = new Map(
  factoryModelObjects.flatMap(object => [object.objectId, ...object.aliases].map(alias => [alias, object.objectId] as const)),
)
