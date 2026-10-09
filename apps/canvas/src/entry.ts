import { Runtime } from "foldkit"
import { initialModel, Model, subscriptions, update } from "./main"
import { view } from "./view"
import "./style.css"

Runtime.run(
  Runtime.makeApplication({
    Model,
    init: () => ({ model: initialModel }),
    update,
    view,
    subscriptions,
    container: document.getElementById("root")
  })
)
