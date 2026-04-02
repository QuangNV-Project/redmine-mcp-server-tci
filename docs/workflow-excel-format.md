# Redmine MCP Server TCI - UI Design Excel Format

## Overview

The UI design and workflow specification is stored in an Excel file (`.xlsx`) with the following sheets:
- **History Change**: Version history and change tracking with color-coding
- **Yêu cầu thiết kế** (Design Requirements): Optional, can be ignored
- **Layout màn hình** (Screen Layout): UI design with numbered components (1, 2, 3, etc.)
- **Giải thích hạng mục** (Component Explanation): Logic and purpose of each numbered component
- **Chi tiết xử lý action** (Action Details): Detailed actions and behaviors for each component

---

## Excel File Structure

### Sheet 1: "History Change"

Tracks version history and changes to the design.

| Column | Type | Description |
|--------|------|-------------|
| `Version` | string | Version number (e.g., v1.0, v1.1) |
| `Date` | date | Change date |
| `Description` | string | Summary of changes |
| `Author` | string | Person who made the change |
| `Color` | color | Background color (used to highlight changes in other sheets) |

#### Example History Change Sheet

```
Version | Date       | Description                          | Author     | Color
--------|------------|--------------------------------------|------------|--------
v1.0    | 2025-08-22 | Initial design                       | John Doe   | No color
v1.1    | 2025-08-25 | Added product search component      | Jane Smith | Yellow
v1.2    | 2025-09-01 | Updated layout and action handlers   | John Doe   | Blue
```

**Notes:**
- Each version should have a unique color for easy identification of changes
- Use Excel cell background color to highlight modified components in other sheets

---

### Sheet 2: "Yêu cầu thiết kế" (Design Requirements)

**Optional** - Can be ignored if not needed. Contains business requirements and specifications.

| Column | Type | Description |
|--------|------|-------------|
| `Requirement ID` | string | Unique identifier (e.g., REQ-001) |
| `Description` | string | Requirement description |
| `Status` | string | Status (Draft, Approved, Implemented) |

---

### Sheet 3: "Layout màn hình" (Screen Layout)

**Main design sheet** - Contains the visual UI design with numbered components.

| Element | Description |
|---------|-------------|
| Visual mockup/screenshot | The actual UI design |
| Numbered components | Components labeled 1, 2, 3, etc. (shown in yellow circles or similar) |
| Color coding (optional) | Use version color from History Change sheet to highlight modified components |

#### Example Structure

```
┌─────────────────────────────────────────────┐
│  Header Logo          [1]  Menu     [2]     │
├─────────────────────────────────────────────┤
│ [3] Search Bar        [4] Filter Options    │
├─────────────────────────────────────────────┤
│ Item 1                Item 2                │  [5] Product List
│ Item 3                Item 4                │
├─────────────────────────────────────────────┤
│                    [6] Pagination/Actions   │
└─────────────────────────────────────────────┘
```

**Notes:**
- Each numbered component should be clearly marked in the Excel screenshot
- Use consistent numbering starting from 1
- Group related components logically

---

### Sheet 4: "Giải thích hạng mục" (Component Explanation)

Explains the logic and purpose of each numbered component from Layout sheet.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `Item #` | number | **Yes** | Component number from Layout sheet (1, 2, 3, etc.) |
| `Component Name` | string | **Yes** | Name/title of the component |
| `Field/Control Type` | string | Yes* | Type: input, dropdown, button, table, list, etc. |
| `Data Source` | string | No | Where data comes from (static, API, database field) |
| `Display Logic` | string | No | When/how component is displayed (always visible, conditional, etc.) |
| `Validation Rules` | string | No | Any validation applied (required, min/max length, format, etc.) |
| `Related Components` | string | No | Other components this depends on or interacts with |

#### Example Component Explanation Sheet

```
Item # | Component Name      | Field/Control Type | Data Source        | Display Logic | Validation Rules        | Related Components
-------|---------------------|--------------------|--------------------|---------------|----------------------|-------------------
1      | Header Logo         | Image              | Static asset       | Always        | None                  | 2 (Menu)
2      | Main Menu           | Navigation buttons | Static menu config | Always        | None                  | 1, 3
3      | Search Bar          | Text input         | User input         | Always        | Min 2 chars, max 100  | 4, 5
4      | Filter Options      | Dropdown/checkboxes| API, filter options| Conditional   | Depends on filters    | 3, 5
5      | Product List        | Table/Grid         | API: /products     | Always        | Paginated (10/page)   | 3, 4, 6
6      | Action Buttons      | Buttons            | Calculated         | Conditional   | None                  | 5
```

**Notes:**
- `Item #` must match the numbering in Layout sheet
- `Field/Control Type` defines the UI element type
- `Display Logic` explains when the component should be visible
- `Validation Rules` lists any constraints on user input
- `Related Components` helps understand component dependencies

---

### Sheet 5: "Chi tiết xử lý action" (Action Details)

Details the specific actions and behaviors triggered by each component.

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `Item #` | number | **Yes** | Component number (must match Layout) |
| `Action Type` | string | **Yes** | Type: click, input_change, submit, select, custom_event |
| `Trigger` | string | **Yes** | What triggers the action (e.g., "Click button", "Enter pressed", "Value selected") |
| `Handler/Logic` | string | **Yes** | What happens when triggered |
| `API/Function` | string | No | API endpoint or function called (if applicable) |
| `Parameters Passed` | string | No | Parameters sent with the action (as JSON or name=value) |
| `Response Handling` | string | No | How response is processed/displayed |
| `Error Handling` | string | No | How errors are handled and displayed |
| `Related Items` | string | No | Other components affected by this action |

#### Example Action Details Sheet

```
Item # | Action Type | Trigger           | Handler/Logic                      | API/Function      | Parameters Passed           | Response Handling | Error Handling        | Related Items
-------|-------------|-------------------|------------------------------------|-------------------|-----------------------------|-----------------------|------|---|
1      | -           | -                 | Navigate to home page              | -                 | -                           | -                 | -                     | 2
2      | click       | Click menu item   | Show menu dropdown                 | -                 | -                           | Show/hide dropdown| -                     | 3, 4, 5
3      | input       | Text entered      | Filter products in real-time       | /api/search       | {query: input_value}        | Update item #5    | Show error message    | 4, 5
4      | select      | Filter option     | Apply filter to product list       | /api/products     | {filters: selected_values}  | Update item #5    | Reset to default      | 5
5      | click       | Click product     | Show product details/modal         | /api/product/:id  | {product_id: id}            | Show modal        | Show error toast      | -
6      | click       | Click button      | Perform bulk action or navigate    | /api/action       | {action: type, items: [...]} | Refresh list      | Show error modal      | 5
```

**Notes:**
- `Item #` must match Layout sheet numbering
- `Action Type` describes the user interaction type
- `Trigger` explains what user action causes the handler to run
- `Handler/Logic` is the core business logic (pseudocode or description)
- `API/Function` lists the endpoint/function called
- `Parameters Passed` shows what data is sent (use JSON format for clarity)
- `Response Handling` explains how to process and display the response
- `Error Handling` defines what happens if the action fails
- `Related Items` shows which components are affected

---

## Complete Example

### Scenario: "Create Purchase Order" Screen

A purchase order (PO) creation screen with the following components:
- Header with logo and menu
- Search bar for suppliers
- Filter options (category, delivery date)
- Product list/table
- Item details and action buttons

### Excel Configuration

**History Change Sheet:**
```
Version | Date        | Description                        | Author      | Color
--------|-------------|------------------------------------|-------------|--------
v1.0    | 2025-08-22  | Initial design                     | John Smith  | (white)
v1.1    | 2025-08-25  | Added supplier search              | Jane Doe    | (yellow)
v1.2    | 2025-09-01  | Redesigned product selection panel | John Smith  | (blue)
```

**Layout Sheet:**
```
Visual mockup showing:
  [1] Header with TC ORDER logo and [2] Menu
  [3] Search bar for supplier        [4] Filter dropdown
  [5] Product list with items
  [6] Add to cart / Create PO buttons
  [7] Quantity and total price fields
```

**Component Explanation Sheet:**
```
Item # | Component Name        | Field Type    | Data Source       | Display Logic | Validation Rules | Related Items
-------|----------------------|---------------|-------------------|---------------|------------------|----------
1      | Header Logo          | Image         | Static            | Always        | None             | 2
2      | Navigation Menu      | Nav buttons   | Static config     | Always        | None             | 1, 3
3      | Supplier Search      | Text input    | Manual entry      | Always        | Min 2 chars      | 4, 5
4      | Category Filter      | Dropdown      | API:/categories   | Always        | None             | 3, 5
5      | Product List Table   | Data table    | API:/products     | Always        | Paginated 10/row | 3, 4, 6
6      | Add to Cart Button   | Button        | Calculated        | Conditional   | Cart not empty   | 5, 7
7      | Total Price Display  | Text display  | Calculated sum    | Always        | Auto-calculated  | 5, 6
```

**Action Details Sheet:**
```
Item # | Action Type | Trigger              | Logic/Handler         | API/Function      | Parameters       | Response Handling | Error Handling
-------|-------------|----------------------|-----------------------|-------------------|-----------------|--------------------|----------
1      | -           | -                    | Navigate home         | -                 | -                | -                  | -
2      | click       | Click menu item      | Show dropdown         | -                 | -                | Show/hide menu     | -
3      | input       | Type supplier name   | Search suppliers      | /api/suppliers    | {q: term}        | Filter list 5      | Show no results
4      | select      | Pick category        | Filter products       | /api/products     | {category: id}   | Update table 5     | Reset filter
5      | click       | Click product row    | Show product details  | /api/product/:id  | {id: productId}  | Show modal popup    | Show error toast
6      | click       | Click "Add to Cart"  | Add item + calc total | /api/cart/add     | {item: {...}}    | Update total #7    | Show error popup
7      | -           | Auto-calculated      | Sum selected items    | -                 | -                | Display amount     | -
```

---

## Plan Response Format

When presenting a design plan based on the Excel file, provide:

### Component Listing
List each numbered component with format:
```
**Item #<number>: <Component Name>**
- Logic: [Summary from Giải thích hạng mục]
- Actions: [Details from Chi tiết xử lý action]
- Related: [Other components it interacts with]
```

### Example Plan Response
```
**Item #3: Supplier Search Bar**
- Logic: Text input field for searching suppliers, requires minimum 2 characters
- Actions:
  - On text input: Call /api/suppliers with search term
  - Display search results in dropdown
  - Error: Show "No suppliers found" message
- Related: Item #4 (filter), Item #5 (product list)

**Item #5: Product List**
- Logic: Paginated data table showing products from API
- Actions:
  - Click row: Show product detail modal
  - Paginate: Load next 10 items
  - Error: Display error toast if API fails
- Related: Item #3 (search), Item #4 (filter), Item #6 (add to cart)
```

---

## Usage Guidelines

### 1. Creating Your Excel File

1. **Create workbook** with these 5 sheets (in order):
   - History Change
   - Yêu cầu thiết kế (optional)
   - Layout màn hình
   - Giải thích hạng mục
   - Chi tiết xử lý action

2. **Design mockup** - Insert screenshot/design in Layout sheet with numbered components

3. **Fill explanations** - Complete Component Explanation sheet with logic and validations

4. **Detail actions** - Complete Action Details sheet with triggers and handlers

### 2. Version Control

- Use History Change sheet to track all design iterations
- Assign unique color to each version for easy filtering
- Highlight modified components in other sheets using version color

### 3. Best Practices

1. **Consistent numbering**: Start from 1, number all interactive components
2. **Clear naming**: Use descriptive names that reflect component purpose
3. **Complete logic**: Fill all rows in Component Explanation sheet
4. **Detailed actions**: Specify exact trigger conditions and API endpoints
5. **Color coding**: Use History Change colors to highlight changes
6. **Component linking**: Always specify related components for dependency tracking
7. **Error handling**: Define error messages and fallback behavior for each action
8. **API endpoints**: Use realistic endpoint paths and parameter formats

---

## Troubleshooting

**Missing components in Layout**
- Ensure all components have unique numbers (1, 2, 3...)
- Check that all numbered items appear in Component Explanation sheet

**Incomplete action details**
- Every interactive component (buttons, inputs) must have entry in Action Details
- Verify Action Type matches component type (click for buttons, input for text fields)
- Include API endpoint and parameters for data-fetching actions

**Inconsistent naming**
- Component names in Explanation sheet must match Layout numbers
- API endpoints should follow RESTful conventions (/api/resource, /api/resource/:id)
