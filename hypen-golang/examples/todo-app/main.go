// Todo-app demonstrates nested state, a typed slice-backed state struct,
// and an inline .UI() template with ForEach — using the typed NewApp[T] API.
package main

import (
	"fmt"
	"log"

	core "github.com/hypen-space/core"
)

// TodoItem is a single row in the todo list.
type TodoItem struct {
	ID        int    `json:"id"`
	Title     string `json:"title"`
	Completed bool   `json:"completed"`
}

// TodoState holds the full module state as a plain Go struct.
// json tags drive both DSL binding (@{state.items}) and the wire format.
type TodoState struct {
	Items  []TodoItem `json:"items"`
	NextID int        `json:"nextId"`
}

func main() {
	todoDef := core.NewApp(
		TodoState{Items: []TodoItem{}, NextID: 1},
		&core.ModuleOptions{Name: "Todo"},
	).
		OnAction("addTodo", func(ctx core.TypedActionContext[TodoState]) {
			title, _ := ctx.Action.Payload.(string)
			if title == "" {
				return
			}
			ctx.State.Items = append(ctx.State.Items, TodoItem{
				ID:        ctx.State.NextID,
				Title:     title,
				Completed: false,
			})
			ctx.State.NextID++
		}).
		OnAction("toggleTodo", func(ctx core.TypedActionContext[TodoState]) {
			id := toInt(ctx.Action.Payload)
			for i := range ctx.State.Items {
				if ctx.State.Items[i].ID == id {
					ctx.State.Items[i].Completed = !ctx.State.Items[i].Completed
					return
				}
			}
		}).
		OnAction("removeTodo", func(ctx core.TypedActionContext[TodoState]) {
			id := toInt(ctx.Action.Payload)
			filtered := ctx.State.Items[:0]
			for _, it := range ctx.State.Items {
				if it.ID != id {
					filtered = append(filtered, it)
				}
			}
			ctx.State.Items = filtered
		}).
		UI(`
			Column {
				Text("Todo List")
					.fontSize(28)
					.fontWeight("bold")

				ForEach(items: @{state.items}) {
					Row {
						Checkbox(checked: @{item.completed})
						Text("@{item.title}")
							.strikethrough(@{item.completed})
						Button("@actions.removeTodo") { Text("×") }
					}
					.key(@{item.id})
				}

				Row {
					TextInput(placeholder: "New task...")
					Button("@actions.addTodo") { Text("Add") }
				}
			}
			.padding(24)
		`)

	instance, err := todoDef.CreateInstance()
	if err != nil {
		log.Fatal(err)
	}
	defer instance.Destroy()

	instance.DispatchAction("addTodo", "Buy groceries")
	instance.DispatchAction("addTodo", "Write documentation")
	instance.DispatchAction("addTodo", "Review pull request")
	instance.DispatchAction("addTodo", "Deploy to staging")
	instance.DispatchAction("toggleTodo", 1)
	instance.DispatchAction("toggleTodo", 3)
	instance.DispatchAction("removeTodo", 2)

	// GetState() returns the module's own state snapshot (without the
	// "todo" prefix the engine sees). Items round-trip as []any of
	// map[string]any because the snapshot is JSON-shaped.
	items, _ := instance.GetState()["items"].([]any)
	for _, raw := range items {
		m, _ := raw.(map[string]any)
		check := "[ ]"
		if completed, _ := m["completed"].(bool); completed {
			check = "[x]"
		}
		fmt.Printf("  %s #%v %s\n", check, m["id"], m["title"])
	}
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	default:
		return 0
	}
}
